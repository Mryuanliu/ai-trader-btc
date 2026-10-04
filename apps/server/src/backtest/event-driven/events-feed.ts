import type { DataSource } from 'typeorm';
import type { Candle, Timeframe } from '@ai-trader/shared';
import { TIMEFRAME_MS } from '@ai-trader/shared';
import { MarketAggTradeEntity } from '../../database/entities/market-agg-trade.entity';
import { MarketMarkPriceEntity } from '../../database/entities/market-mark-price.entity';
import { MarketFundingRateEntity } from '../../database/entities/market-funding-rate.entity';
import { MarketCandleEntity } from '../../database/entities/market-candle.entity';
import { EVENT_KIND_ORDER, type MarketEvent } from './types';

/**
 * 从 DB 组装 [from, to] 区间的事件流（Point-in-Time）。
 *
 * 归并策略：
 * 1. **一次性物化到内存数组**再排序 —— BTCUSDT 4h 一年 ≈ 2200 bar + 4380 funding + 525k markPrice
 *    + 数百万 aggTrade。为避免爆内存，aggTrade 分段（默认按 bar 边界切片）流式读取。
 * 2. 同 ts 内按 `EVENT_KIND_ORDER` 稳定排序：markPrice 先到 → aggTrade 逐笔 → 8h 结算落账 → bar 收盘
 *    （markPrice 先于 aggTrade 保证「强平判定使用当时 mark」；bar 最后保证策略 onTick 看到完整一根）。
 *
 * **拒绝降级冒充**：区间内没有 aggTrades → 抛错，除非配置显式 `allowBarFallback=true`
 * （那是 vectorized 语义，engineVersion 会退回 'vectorized-v1'，闸门继续 pending）。
 */

export interface LoadEventsArgs {
  ds: DataSource;
  symbol: string;
  interval: Timeframe;
  from: number;
  to: number;
  /** K 线（bar 事件）来源：DB market_candles 或外部预加载（walk-forward 切窗时用预加载避免重复拉） */
  candles?: Candle[];
  /** 强制关闭 aggTrade 需求（仅用于最小冒烟测试；正式回测须为 false） */
  allowBarFallback?: boolean;
}

/** 单批上限，控制内存峰值 */
const AGG_PAGE = 50_000;

async function loadAggTrades(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
): Promise<MarketEvent[]> {
  const out: MarketEvent[] = [];
  let cursor = from;
  while (cursor <= to) {
    const rows = await ds
      .getRepository(MarketAggTradeEntity)
      .createQueryBuilder('a')
      .where('a.symbol = :symbol', { symbol })
      .andWhere('a.market = :market', { market: 'futures' })
      .andWhere('a.tradeTime BETWEEN :cursor AND :to', { cursor, to })
      .orderBy('a.tradeTime', 'ASC')
      .addOrderBy('a.aggTradeId', 'ASC')
      .take(AGG_PAGE)
      .getMany();
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        kind: 'aggTrade',
        ts: Number(r.tradeTime),
        price: Number(r.price),
        qty: Number(r.qty),
        isBuyerMaker: Boolean(r.isBuyerMaker),
      });
    }
    const last = Number(rows[rows.length - 1].tradeTime);
    if (rows.length < AGG_PAGE || last >= to) break;
    cursor = last + 1;
  }
  return out;
}

async function loadMarkPrices(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
): Promise<MarketEvent[]> {
  const rows = await ds
    .getRepository(MarketMarkPriceEntity)
    .createQueryBuilder('m')
    .where('m.symbol = :symbol', { symbol })
    .andWhere('m.market = :market', { market: 'futures' })
    .andWhere('m.ts BETWEEN :from AND :to', { from, to })
    .orderBy('m.ts', 'ASC')
    .getMany();
  return rows.map((r) => ({
    kind: 'markPrice' as const,
    ts: Number(r.ts),
    markPrice: Number(r.markPrice),
  }));
}

async function loadFundingEvents(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
): Promise<MarketEvent[]> {
  const rows = await ds
    .getRepository(MarketFundingRateEntity)
    .createQueryBuilder('f')
    .where('f.symbol = :symbol', { symbol })
    .andWhere('f.fundingTime BETWEEN :from AND :to', { from, to })
    .orderBy('f.fundingTime', 'ASC')
    .getMany();
  return rows.map((r) => ({
    kind: 'fundingSettlement' as const,
    ts: Number(r.fundingTime),
    rate: Number(r.fundingRate),
    markPrice: r.markPrice !== null ? Number(r.markPrice) : 0,
  }));
}

async function loadCandlesFromDb(
  ds: DataSource,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
): Promise<Candle[]> {
  const rows = await ds
    .getRepository(MarketCandleEntity)
    .createQueryBuilder('c')
    .where('c.symbol = :symbol', { symbol })
    .andWhere('c.market = :market', { market: 'futures' })
    .andWhere('c.interval = :interval', { interval })
    .andWhere('c.openTime BETWEEN :from AND :to', { from, to })
    .orderBy('c.openTime', 'ASC')
    .getMany();
  return rows.map((r) => ({
    time: Number(r.openTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/** 归并 + 稳定排序：同 ts 按 kind 序，其次按插入序（Array.prototype.sort 稳定） */
function mergeEvents(buckets: MarketEvent[][]): MarketEvent[] {
  const flat: MarketEvent[] = [];
  for (const b of buckets) for (const e of b) flat.push(e);
  flat.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return EVENT_KIND_ORDER[a.kind] - EVENT_KIND_ORDER[b.kind];
  });
  return flat;
}

/** 事件流构造入口；调用方必须先通过 data-quality 门禁 */
export async function loadMarketEvents(args: LoadEventsArgs): Promise<{
  events: MarketEvent[];
  candles: Candle[];
  stats: { aggTradeCount: number; markPriceCount: number; fundingEvents: number; barCount: number };
}> {
  const candles =
    args.candles ?? (await loadCandlesFromDb(args.ds, args.symbol, args.interval, args.from, args.to));
  if (candles.length === 0) {
    throw new Error(
      `event-driven 需要区间内 K 线（bar 事件）：${args.symbol} ${args.interval} ${args.from}~${args.to} 无数据`,
    );
  }
  const [aggs, marks, fundings] = await Promise.all([
    loadAggTrades(args.ds, args.symbol, args.from, args.to),
    loadMarkPrices(args.ds, args.symbol, args.from, args.to),
    loadFundingEvents(args.ds, args.symbol, args.from, args.to),
  ]);

  if (aggs.length === 0 && !args.allowBarFallback) {
    throw new Error(
      `event-driven 引擎拒绝启动：区间内无 aggTrades。请 pnpm pull-history --only agg 补齐，` +
        `或显式配置 allowBarFallback=true（会退回 vectorized 保真度）。`,
    );
  }

  const barEvents: MarketEvent[] = candles.map((c) => ({
    kind: 'bar' as const,
    ts: c.time + TIMEFRAME_MS[args.interval], // bar 收盘时刻（openTime + interval）
    bar: c,
    interval: args.interval,
  }));

  const events = mergeEvents([marks, aggs, fundings, barEvents]);
  return {
    events,
    candles,
    stats: {
      aggTradeCount: aggs.length,
      markPriceCount: marks.length,
      fundingEvents: fundings.length,
      barCount: candles.length,
    },
  };
}
