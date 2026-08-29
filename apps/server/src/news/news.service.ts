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

const SIMULATED_TITLES: { title: string; source: string; tags: string[] }[] = [
  {
    title: '比特币现货 ETF 单周净流入 12.4 亿美元，机构配置需求延续',
    source: 'CoinDesk',
    tags: ['比特币', 'ETF', '机构'],
  },
  {
    title: '美联储会议纪要偏鹰，交易员下调年内降息预期至一次',
    source: 'Cointelegraph',
    tags: ['美联储', '降息'],
  },
  {
    title: '链上数据：交易所 BTC 余额降至五年低位，筹码持续向冷钱包转移',
    source: 'CryptoQuant',
    tags: ['链上', 'BTC'],
  },
  {
    title: '美国 10 月 CPI 同比 2.6%，核心通胀粘性仍高于目标',
    source: 'Bloomberg Crypto',
    tags: ['CPI', '通胀'],
  },
  {
    title: 'BTC 永续合约资金费率转正，多头杠杆需求回暖',
    source: 'The Block',
    tags: ['期货', 'BTC'],
  },
  {
    title: 'MicroStrategy 再度增持 5,500 枚 BTC，总持仓突破 25 万枚',
    source: 'CoinDesk',
    tags: ['MicroStrategy', 'BTC'],
  },
  {
    title: '全网 24 小时合约爆仓 3.2 亿美元，其中多单占比 68%',
    source: 'Cointelegraph',
    tags: ['清算', '爆仓'],
  },
  {
    title: 'Bitcoin 全网算力突破 780 EH/s，挖矿难度创历史新高',
    source: 'Bitcoin Magazine',
    tags: ['算力', '矿工'],
  },
  {
    title: 'SEC 主席重申数字资产监管框架需立法明确，短期难有定论',
    source: 'Reuters Crypto',
    tags: ['SEC', '监管'],
  },
  {
    title: '稳定币总市值单月增加 42 亿美元，USDT 市占率回升至 71%',
    source: 'The Block',
    tags: ['稳定币', 'USDT'],
  },
  {
    title: '巨鲸地址买入 3,200 枚 BTC，为近三周最大单笔链上买入',
    source: 'Whale Alert',
    tags: ['巨鲸', 'BTC'],
  },
  {
    title: '欧洲央行下调基准利率 25 基点，欧元区流动性环境边际改善',
    source: 'Bloomberg Crypto',
    tags: ['降息'],
  },
  {
    title: '灰度 GBTC 单日流出收窄至 1,800 万美元，抛压明显减弱',
    source: 'CoinDesk',
    tags: ['灰度', 'ETF'],
  },
  {
    title: '比特币第三次减半后矿工收入结构变化：手续费占比升至 12%',
    source: 'Bitcoin Magazine',
    tags: ['减半', '矿工'],
  },
  {
    title: '贝莱德 IBIT 期权持仓量创新高，隐含波动率维持高位',
    source: 'The Block',
    tags: ['BlackRock', 'ETF'],
  },
  {
    title: '美元指数回落至 103 下方，风险资产整体受益',
    source: 'Reuters Crypto',
    tags: ['美联储'],
  },
  {
    title: '链上活跃地址数环比增长 8.4%，网络使用度稳步抬升',
    source: 'CryptoQuant',
    tags: ['链上', 'BTC'],
  },
  {
    title: '亚洲时段 BTC 现货买盘增强，韩元溢价重新转正',
    source: 'Cointelegraph',
    tags: ['现货', 'BTC'],
  },
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
  async fetchAll(): Promise<{ added: number; simulated: boolean }> {
    if (!isTruthy(this.config.get('NEWS_ENABLED'), true)) {
      return { added: 0, simulated: false };
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
    for (const result of results) {
      if (result.ok) {
        anySuccess = true;
        added += result.added;
      }
    }

    if (!anySuccess) {
      added += await this.seedSimulated();
      return { added, simulated: true };
    }
    return { added, simulated: false };
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

  /** 外部 RSS 不可达时的拟真新闻源，保证决策链路有新闻输入 */
  async seedSimulated(): Promise<number> {
    const count = await this.repo.count({ where: { source: '模拟源' } });
    if (count >= SIMULATED_TITLES.length) return 0;

    let added = 0;
    const now = Date.now();
    for (let i = 0; i < SIMULATED_TITLES.length; i += 1) {
      const item = SIMULATED_TITLES[i];
      const url = `simulated://news/${i}`;
      const exists = await this.repo.findOne({ where: { url } });
      if (exists) continue;
      const saved = await this.repo.save(
        this.repo.create({
          title: item.title,
          summary: `${item.title}。本文为本地模拟新闻，用于在没有外网时的决策链路演示。`,
          url,
          source: '模拟源',
          publishedAt: new Date(now - (i + 1) * 37 * 60_000),
          tags: item.tags,
        }),
      );
      this.events.emit('news', this.toDTO(saved));
      added += 1;
    }
    if (added > 0) {
      this.logger.warn(`外部新闻源不可达，已注入 ${added} 条模拟新闻`);
    }
    return added;
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
