import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { CalendarEventDTO } from '@ai-trader/shared';
import { axiosTransport } from '../common/proxy';

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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '未知来源';
  }
}

/**
 * ForexFactory 每周财经日历的免费 JSON feed（无需 API Key）。
 *
 * 交易者最通用的宏观事件来源：FOMC 议息、非农、CPI、各国央行决议都在这里，
 * 且自带「影响等级」（High/Medium/Low）——这正是筛选「值得盯的事件」的关键。
 */
const FF_FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

const CACHE_TTL_MS = 60 * 60 * 1000; // 日历是周级数据，1 小时刷新一次足够

interface RawFeedEvent {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
}

/**
 * 财经日历服务。
 *
 * 为什么选 ForexFactory 而不是 Trading Economics / Finnhub：
 * - **免费且无需 API Key**：T.E. 与 Finnhub 的日历都在付费墙后
 * - **交易者事实标准**：绝大多数交易终端引用的就是这份日历
 * - **自带影响分级**：High/Medium/Low 直接可用，不用自己维护白名单
 *
 * 存储：**内存缓存**而非落库——数据量小（每周几十条）、源是周级的全量快照，
 * 落库只会引入「过期事件清理」这类额外负担，没有收益。
 */
@Injectable()
export class CalendarService implements OnModuleInit {
  private readonly logger = new Logger(CalendarService.name);
  private cache: CalendarEventDTO[] = [];
  private cachedAt = 0;
  private fetching: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** 启动预热：避免首屏空日历 */
  onModuleInit() {
    const timer = setTimeout(() => {
      void this.refresh().catch((err) => this.logger.warn(`日历预热失败: ${err.message}`));
    }, 6000);
    if (timer.unref) timer.unref();
  }

  /**
   * 事件列表。
   *
   * 默认只返回 High + Medium：Low 级别绝大多数是各国官员讲话，
   * 对 BTC 影响微弱，全量展示会把真正重要的决议淹没掉。
   * 传 `impact=all` 可拿全量。
   */
  async list(impact?: string): Promise<CalendarEventDTO[]> {
    await this.ensure();
    if (impact === 'all') return this.cache;
    return this.cache.filter((e) => e.impact === 'High' || e.impact === 'Medium');
  }

  /** 强制刷新（绕过缓存） */
  async refresh(): Promise<{ fetched: number }> {
    await this.fetch();
    return { fetched: this.cache.length };
  }

  private async ensure(): Promise<void> {
    if (this.cache.length > 0 && Date.now() - this.cachedAt < CACHE_TTL_MS) return;
    if (!this.fetching) {
      this.fetching = this.fetch()
        .catch((err) => this.logger.warn(`日历抓取失败: ${err.message}`))
        .finally(() => {
          this.fetching = null;
        });
    }
    await this.fetching;
  }

  private async fetch(): Promise<void> {
    const results = await Promise.all(
      FF_FEEDS.map(async (url) => {
        try {
          const res = await withTimeout(
            axios.get<RawFeedEvent[]>(url, {
              timeout: 12_000,
              headers: { 'User-Agent': 'ai-trader-btc/0.1 (+calendar-reader)' },
              ...axiosTransport(hostOf(url)),
            }),
            14_000,
            `${url} 抓取超时`,
          );
          return res.data ?? [];
        } catch (err) {
          this.logger.warn(`日历源抓取失败 ${url}: ${(err as Error).message}`);
          return [];
        }
      }),
    );

    const merged = [...results[0], ...results[1]]
      .filter((e) => e.title && e.date)
      .map((e): CalendarEventDTO => ({
        title: String(e.title).trim(),
        country: String(e.country ?? '').trim(),
        date: String(e.date),
        impact: (['High', 'Medium', 'Low', 'Holiday'].includes(String(e.impact))
          ? String(e.impact)
          : 'Low') as CalendarEventDTO['impact'],
        forecast: String(e.forecast ?? ''),
        previous: String(e.previous ?? ''),
      }))
      // 去重（两份 feed 可能在交界日重叠），再按时间升序
      .filter(
        (e, i, arr) =>
          arr.findIndex((x) => x.title === e.title && x.date === e.date) === i,
      )
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (merged.length > 0) {
      this.cache = merged;
      this.cachedAt = Date.now();
      this.logger.log(`财经日历已更新：${merged.length} 个事件（本周 + 下周）`);
    }
  }
}
