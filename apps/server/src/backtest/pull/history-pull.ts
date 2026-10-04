import 'dotenv/config';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { axiosTransport } from '../../common/proxy';
import { MarketAggTradeEntity } from '../../database/entities/market-agg-trade.entity';
import { MarketFundingRateEntity } from '../../database/entities/market-funding-rate.entity';
import { MarketMarkPriceEntity } from '../../database/entities/market-mark-price.entity';
import { MarketOpenInterestEntity } from '../../database/entities/market-open-interest.entity';
import { MarketSymbolMetaEntity } from '../../database/entities/market-symbol-meta.entity';

/**
 * P1-A3 L1 数据栈拉取管道（Point-in-Time 事实入库）。
 *
 * 与 `historical-feed.ts` 的分工：
 * - `historical-feed` 是 vectorized 引擎的**内联取数**（可无 DB 跑，缓存到 JSON 文件）
 * - 本模块是**入库**，供 event-driven 引擎按窗口读取，是 P1-A4 的数据地基
 *
 * 5 个 puller：
 * - `pullSymbolMeta` — `/fapi/v1/exchangeInfo`：精度/杠杆/维持保证金分层
 * - `pullFundingRates` — `/fapi/v1/fundingRate`：历史资金费结算事实（每 8h 一条）
 * - `pullMarkPriceKlines` — `/fapi/v1/markPriceKlines`：markPrice 分钟粒度
 * - `pullAggTrades` — `/fapi/v1/aggTrades`：逐笔成交（分页最多 1000/次，1m 内数百条）
 * - `pullOpenInterestHist` — `/futures/data/openInterestHist`：OI（**只近 30 天有**）
 *
 * 全部**幂等 upsert**：`(symbol, market, ts)` 冲突即覆盖，反复跑不产生重复。
 * 网络：所有请求走 `axiosTransport` 以复用代理与 NO_PROXY 逻辑（记忆：本地 Clash 端口）。
 */

const DEFAULT_HOST = process.env.BACKTEST_KLINE_HOST || 'https://fapi.binance.com';
const DAY_MS = 86_400_000;
const FUNDING_INTERVAL_MS = 8 * 3_600_000;

/** 通用：带重试的 GET（Binance 429/5xx 常见） */
async function getJson<T>(
  url: string,
  params: Record<string, string | number>,
  { timeoutMs = 30_000, retries = 3 } = {},
): Promise<T> {
  const host = new URL(url).hostname;
  let lastErr: unknown;
  for (let i = 0; i < retries; i += 1) {
    try {
      const { data } = await axios.get<T>(url, {
        params,
        timeout: timeoutMs,
        ...axiosTransport(host),
      });
      return data;
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } }).response?.status ?? 0;
      // 429/418 需退避更长；4xx（非 429/418）直接抛
      if (status && status < 500 && status !== 429 && status !== 418) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1) * (status === 429 || status === 418 ? 3 : 1)));
    }
  }
  throw lastErr;
}

/** ---------- SymbolMeta ---------- */
interface BinanceFuturesSymbolInfo {
  symbol: string;
  contractType: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  maxLeverage?: string;
  filters: Array<Record<string, unknown> & { filterType: string }>;
  notionalLever?: Array<{ leverage: string; notional: string }>;
  marginTaxRates?: Record<string, string>;
}
interface ExchangeInfoResp {
  symbols: BinanceFuturesSymbolInfo[];
}

export async function pullSymbolMeta(ds: DataSource, symbol: string): Promise<number> {
  const data = await getJson<ExchangeInfoResp>(`${DEFAULT_HOST}/fapi/v1/exchangeInfo`, {});
  const s = data.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Binance exchangeInfo 无该 symbol：${symbol}`);
  const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER') as
    | { tickSize?: string }
    | undefined;
  const lotSize = s.filters.find((f) => f.filterType === 'LOT_SIZE') as
    | { stepSize?: string; minQty?: string }
    | undefined;
  const minNotional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL') as
    | { notional?: string; minNotional?: string }
    | undefined;
  const tickSize = Number(priceFilter?.tickSize ?? '0.1');
  const stepSize = Number(lotSize?.stepSize ?? '0.001');
  const minN = Number(minNotional?.notional ?? minNotional?.minNotional ?? '100');
  const tiers = (s.notionalLever ?? [])
    .map((b) => ({
      leverage: Number(b.leverage),
      notionalCap: Number(b.notional),
      maintMarginRatio: 0, // Binance 不直接返回；上层按需从 marginTiers 补
      cum: 0,
    }))
    .sort((a, b) => a.leverage - b.leverage);
  const repo = ds.getRepository(MarketSymbolMetaEntity);
  const row: Partial<MarketSymbolMetaEntity> = {
    symbol: s.symbol,
    market: 'futures',
    contractType: s.contractType,
    quoteAsset: s.quoteAsset,
    tickSize,
    stepSize,
    minNotional: minN,
    pricePrecision: s.pricePrecision,
    quantityPrecision: s.quantityPrecision,
    maxLeverage: Number(s.maxLeverage ?? tiers[tiers.length - 1]?.leverage ?? 20),
    leverageBrackets: tiers,
    marginTiers: [],
    fetchedAt: new Date(),
  };
  await repo.upsert(row as MarketSymbolMetaEntity, ['symbol', 'market']);
  return 1;
}

/** ---------- FundingRate ---------- */
interface FundingRateRow {
  fundingRate: string;
  fundingTime: number;
  markPrice?: string;
}

export async function pullFundingRates(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
): Promise<number> {
  const repo = ds.getRepository(MarketFundingRateEntity);
  let cursor = from;
  let total = 0;
  while (cursor < to) {
    const rows = await getJson<FundingRateRow[]>(`${DEFAULT_HOST}/fapi/v1/fundingRate`, {
      symbol,
      startTime: cursor,
      endTime: to,
      limit: 1000,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    const batch = rows
      .filter((r) => r.fundingTime >= from && r.fundingTime <= to)
      .map((r) => ({
        symbol,
        fundingTime: Number(r.fundingTime),
        fundingRate: String(r.fundingRate),
        markPrice: r.markPrice !== undefined ? Number(r.markPrice) : null,
      }));
    if (batch.length) {
      await repo.upsert(batch as MarketFundingRateEntity[], ['symbol', 'fundingTime']);
      total += batch.length;
    }
    const last = Number(rows[rows.length - 1].fundingTime);
    if (rows.length < 1000 || last >= to) break;
    cursor = last + 1;
  }
  return total;
}

/** ---------- MarkPriceKlines（分钟粒度 mark price 历史） ---------- */
export async function pullMarkPriceKlines(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
  interval = '1m',
): Promise<number> {
  const repo = ds.getRepository(MarketMarkPriceEntity);
  let cursor = from;
  let total = 0;
  while (cursor < to) {
    const rows = await getJson<unknown[][]>(`${DEFAULT_HOST}/fapi/v1/markPriceKlines`, {
      symbol,
      interval,
      startTime: cursor,
      endTime: to,
      limit: 1500,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    const batch = rows.map((r) => ({
      symbol,
      market: 'futures' as const,
      ts: Number(r[0]),
      markPrice: Number(r[4]), // close of markPrice kline = 该分钟末 mark
      indexPrice: null,
      lastFundingRate: null,
      nextFundingTime: null,
    }));
    await repo.upsert(batch as unknown as MarketMarkPriceEntity[], ['symbol', 'market', 'ts']);
    total += batch.length;
    const last = Number(rows[rows.length - 1][0]);
    if (rows.length < 1500 || last >= to) break;
    cursor = last + 1;
  }
  return total;
}

/** ---------- AggTrades（逐笔） ---------- */
interface AggTradeRow {
  a: number; // aggTradeId
  p: string; // price
  q: string; // qty
  f: number; // firstId
  l: number; // lastId
  T: number; // transactTime
  m: boolean; // isBuyerMaker
}

/**
 * 单页 1000 条上限。BTCUSDT 高潮时段 1m 可上千条；这里**按时间窗切片**保证覆盖，
 * 若某窗返回 1000 条即视为可能截断，切半重试（简单递归）。
 */
export async function pullAggTrades(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
): Promise<number> {
  const repo = ds.getRepository(MarketAggTradeEntity);
  const chunk = 60_000; // 1 分钟一片，避免 1000 上限
  let total = 0;
  for (let cursor = from; cursor < to; cursor += chunk) {
    const end = Math.min(cursor + chunk - 1, to);
    let localCursor = cursor;
    let guard = 0;
    while (localCursor <= end && guard < 200) {
      guard += 1;
      const rows = await getJson<AggTradeRow[]>(`${DEFAULT_HOST}/fapi/v1/aggTrades`, {
        symbol,
        startTime: localCursor,
        endTime: end,
        limit: 1000,
      });
      if (!Array.isArray(rows) || rows.length === 0) break;
      const batch = rows.map((r) => ({
        symbol,
        market: 'futures' as const,
        aggTradeId: Number(r.a),
        tradeTime: Number(r.T),
        price: Number(r.p),
        qty: Number(r.q),
        quoteQty: Number(r.p) * Number(r.q),
        isBuyerMaker: Boolean(r.m),
        firstId: Number(r.f),
        lastId: Number(r.l),
      }));
      await repo.upsert(batch as unknown as MarketAggTradeEntity[], ['symbol', 'market', 'aggTradeId']);
      total += batch.length;
      const last = Number(rows[rows.length - 1].T);
      if (rows.length < 1000) break;
      localCursor = last + 1;
    }
  }
  return total;
}

/** ---------- OpenInterestHist（近 30 天） ---------- */
interface OiRow {
  pooledSymbol?: string;
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export async function pullOpenInterestHist(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
  period = '5m',
): Promise<number> {
  const repo = ds.getRepository(MarketOpenInterestEntity);
  // Binance 硬约束：只允许拉最近 30 天
  const earliest = Date.now() - 30 * DAY_MS;
  const start = Math.max(from, earliest);
  if (start >= to) {
    // eslint-disable-next-line no-console
    console.warn(`[oi] 区间 ${new Date(from).toISOString()}~${new Date(to).toISOString()} 完全超出 Binance 30 天窗口，跳过`);
    return 0;
  }
  if (start > from) {
    // eslint-disable-next-line no-console
    console.warn(`[oi] 起始时间截断至 30 天前(${new Date(earliest).toISOString()})，早于此刻的数据不可得`);
  }
  let cursor = start;
  let total = 0;
  while (cursor < to) {
    const rows = await getJson<OiRow[]>(`${DEFAULT_HOST}/futures/data/openInterestHist`, {
      symbol,
      period,
      startTime: cursor,
      endTime: to,
      limit: 500,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    const batch = rows.map((r) => ({
      symbol,
      market: 'futures' as const,
      ts: Number(r.timestamp),
      openInterest: Number(r.sumOpenInterest),
      openInterestValue: Number(r.sumOpenInterestValue),
    }));
    await repo.upsert(batch as unknown as MarketOpenInterestEntity[], ['symbol', 'market', 'ts']);
    total += batch.length;
    const last = Number(rows[rows.length - 1].timestamp);
    if (rows.length < 500 || last >= to) break;
    cursor = last + 1;
  }
  return total;
}

/** 8h 结算网格覆盖度（供 data-quality 用） */
export function fundingSlotsInRange(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / FUNDING_INTERVAL_MS) + 1);
}

/** 独立入口：便于测试与 CLI 之外二次调用 */
export async function withDataSource<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  try {
    return await fn(AppDataSource);
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}
