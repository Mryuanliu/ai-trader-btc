import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { KeywordTrend, NewsItemDTO } from '@ai-trader/shared';
import { In, LessThan, Repository } from 'typeorm';
import Parser from 'rss-parser';
import axios from 'axios';
import { NewsItemEntity } from '../database/entities';
import { EventBusService } from '../common/events';
import { isTruthy } from '../common/env.util';
import { axiosTransport } from '../common/proxy';

const KEYWORDS = [
  '比特币',
  'BTC',
  'Bitcoin',
  'ETF',
  '美联储',
  '降息',
  '加息',
  '通胀',
  'CPI',
  '减半',
  'Halving',
  '矿工',
  '算力',
  '监管',
  'SEC',
  '现货',
  '期货',
  '清算',
  '爆仓',
  '巨鲸',
  '链上',
  '稳定币',
  'USDT',
  '以太坊',
  'ETH',
  'Solana',
  'ETF 资金',
  '机构',
  'MicroStrategy',
  'BlackRock',
  '灰度',
];


@Injectable()
export class NewsService implements OnModuleInit {
  private readonly logger = new Logger(NewsService.name);
  private readonly parser = new Parser({ timeout: 10000 });

  constructor(
    @InjectRepository(NewsItemEntity)
    private readonly repo: Repository<NewsItemEntity>,
    private readonly config: ConfigService,
    private readonly events: EventBusService,
  ) {}

  /** 启动后预热新闻，避免首屏空白；延后执行以等待表结构就绪 */
  onModuleInit() {
    const timer = setTimeout(() => {
      void this.fetchAll().catch((err) => this.logger.warn(`新闻预热失败: ${err.message}`));
    }, 4000);
    if (timer.unref) timer.unref();
  }

  private get sources(): string[] {
    const raw = this.config.get<string>('NEWS_SOURCES', '') || '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ------------------------------------------------------------------
  // 抓取与降级
  // ------------------------------------------------------------------
  async fetchAll(): Promise<{ added: number; failed: number }> {
    if (!isTruthy(this.config.get('NEWS_ENABLED'), true)) {
      return { added: 0, failed: this.sources.length };
    }

    const sources = this.sources;
    let anySuccess = false;

    // 并发抓取并强制超时，避免单个不可达源把整个抓取流程拖死
    const results = await Promise.all(
      sources.map(async (url) => {
        try {
          const feed = await this.fetchFeed(url);
          let added = 0;
          for (const item of feed.items.slice(0, 20)) {
            if (!item.title || !item.link) continue;
            const saved = await this.upsert({
              title: item.title.trim(),
              summary: stripHtml(item.contentSnippet ?? item.summary ?? '').slice(0, 300),
              url: item.link,
              source: feed.title?.slice(0, 64) || hostOf(url),
              publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
            });
            if (saved) added += 1;
          }
          return { ok: true as const, added };
        } catch (err) {
          this.logger.warn(`新闻源抓取失败 ${url}: ${(err as Error).message}`);
          return { ok: false as const, added: 0 };
        }
      }),
    );

    let added = 0;
    let failed = 0;
    for (const result of results) {
      if (result.ok) {
        anySuccess = true;
        added += result.added;
      } else {
        failed += 1;
      }
    }

    // 不再注入模拟新闻：外部源全部不可达时宁可留空，
    // 也不能让「编造的新闻」进入决策链路（AI 行情分析会把它当真）
    if (!anySuccess) {
      this.logger.warn(`全部新闻源抓取失败（${failed} 个），本轮无新增`);
    }
    return { added, failed };
  }

  /**
   * 先用 axios 拉取 XML（从而复用统一代理配置），再交给 rss-parser 解析。
   * 直接用 parser.parseURL 会走 Node 原生 https，绕过代理导致境外源超时。
   */
  private async fetchFeed(url: string): Promise<Parser.Output<Record<string, unknown>>> {
    const xml = await withTimeout(
      axios
        .get<string>(url, {
          timeout: 12_000,
          responseType: 'text',
          headers: { 'User-Agent': 'ai-trader-btc/0.1 (+rss-reader)' },
          ...axiosTransport(hostOf(url)),
        })
        .then((res) => res.data),
      14_000,
      `${url} 抓取超时`,
    );
    return this.parser.parseString(xml);
  }

  private async upsert(input: {
    title: string;
    summary: string;
    url: string;
    source: string;
    publishedAt: Date;
  }): Promise<boolean> {
    const exists = await this.repo.findOne({ where: { url: input.url } });
    if (exists) return false;
    const entity = this.repo.create({
      title: input.title,
      summary: input.summary,
      url: input.url,
      source: input.source,
      publishedAt: input.publishedAt,
      tags: extractTags(input.title, input.summary),
    });
    const saved = await this.repo.save(entity);
    this.events.emit('news', this.toDTO(saved));
    return true;
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------
  toDTO(row: NewsItemEntity): NewsItemDTO {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      url: row.url,
      source: row.source,
      publishedAt: row.publishedAt.toISOString(),
      tags: row.tags ?? [],
      citedCount: row.citedCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(params: {
    page?: number;
    pageSize?: number;
    source?: string;
    keyword?: string;
  }): Promise<{ items: NewsItemDTO[]; total: number }> {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 20));

    const qb = this.repo.createQueryBuilder('n');
    if (params.source) qb.andWhere('n.source = :source', { source: params.source });
    if (params.keyword) {
      qb.andWhere('(n.title ILIKE :kw OR n.summary ILIKE :kw)', { kw: `%${params.keyword}%` });
    }
    qb.orderBy('n.publishedAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.toDTO(r)), total };
  }

  /** 决策上下文使用的最近新闻 */
  async getRecent(limit = 6): Promise<NewsItemDTO[]> {
    const rows = await this.repo.find({
      order: { publishedAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => this.toDTO(r));
  }

  async sources$(): Promise<{ source: string; count: number }[]> {
    const rows = await this.repo
      .createQueryBuilder('n')
      .select('n.source', 'source')
      .addSelect('COUNT(*)', 'count')
      .groupBy('n.source')
      .orderBy('count', 'DESC')
      .getRawMany<{ source: string; count: string }>();
    return rows.map((r) => ({ source: r.source, count: Number(r.count) }));
  }

  async keywordTrends(limit = 12): Promise<KeywordTrend[]> {
    const rows = await this.repo.find({
      order: { publishedAt: 'DESC' },
      take: 200,
      select: ['tags'],
    });
    const counter = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags ?? []) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }
    return [...counter.entries()]
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /** 决策引用新闻后累加引用次数 */
  async markCited(titles: string[]) {
    if (titles.length === 0) return;
    const rows = await this.repo.find({ where: { title: In(titles) } });
    for (const row of rows) {
      row.citedCount += 1;
    }
    if (rows.length > 0) await this.repo.save(rows);
  }

  /** 清理过期新闻，避免表无限增长 */
  async prune(keepDays = 30) {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000);
    await this.repo.delete({ publishedAt: LessThan(cutoff) });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '未知来源';
  }
}

function extractTags(title: string, summary: string): string[] {
  const text = `${title} ${summary}`;
  return KEYWORDS.filter((k) => text.toLowerCase().includes(k.toLowerCase())).slice(0, 5);
}
