import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import axios from 'axios';
import type { Candle, Timeframe } from '@ai-trader/shared';
import { axiosTransport } from '../common/proxy';

/**
 * 历史 K 线数据源。
 *
 * 只用**公共行情端点**（klines 市场数据无需签名/密钥），可脱离 DB 与交易所账户独立跑。
 * - 默认主机 `fapi.binance.com`（合约口径）；用环境变量 `BACKTEST_KLINE_HOST` 可切到
 *   `data-api.binance.vision`（轻量公共行情，某些网络更可达）等。
 * - 分页抓取（单次上限 1500 根）；命中缓存文件则直接读，避免重复联网。
 */
const KLINE_HOST = process.env.BACKTEST_KLINE_HOST || 'https://fapi.binance.com';

/** 单次请求上限：合约 klines 为 1500 */
const PAGE_LIMIT = 1500;

interface FetchOpts {
  host?: string;
}

/** 从本地 JSON 载入 K 线：兼容裸 Candle[] 与 {candles:[...]} 两种形态 */
export function loadCandlesFromFile(path: string): Candle[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const arr: unknown[] = Array.isArray(raw) ? raw : raw.candles;
  if (!Array.isArray(arr)) throw new Error(`K 线文件格式无法识别：${path}`);
  return (arr as Candle[]).map((c) => ({
    time: Number(c.time),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume ?? 0),
  }));
}

/** 联网分页拉取 [from, to] 区间的 K 线 */
export async function fetchFuturesKlines(
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
  opts: FetchOpts = {},
): Promise<Candle[]> {
  const host = opts.host || KLINE_HOST;
  const out: Candle[] = [];
  let cursor = from;
  // 分批拉，直到覆盖到 to 或空返回
  for (;;) {
    const { data } = await axios.get<unknown[][]>(`${host}/fapi/v1/klines`, {
      params: { symbol, interval, startTime: cursor, endTime: to, limit: PAGE_LIMIT },
      timeout: 30_000,
      ...axiosTransport(host.replace(/^https?:\/\//, '')),
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      out.push({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
    }
    const lastCloseTime = Number(data[data.length - 1][6]);
    if (lastCloseTime >= to) break;
    if (data.length < PAGE_LIMIT) break; // 已到尾
    cursor = lastCloseTime + 1;
  }
  // 去重并按时间升序
  const dedup = new Map<number, Candle>();
  for (const c of out) if (c.time >= from && c.time <= to) dedup.set(c.time, c);
  return [...dedup.values()].sort((a, b) => a.time - b.time);
}

function cachePath(cacheDir: string, symbol: string, interval: string, from: number, to: number): string {
  return join(cacheDir, `${symbol}-${interval}-${from}-${to}.json`);
}

/**
 * 回测统一取数入口：file > 缓存 > 联网（并落缓存）。
 */
export async function loadHistoricalCandles(args: {
  symbol: string;
  interval: Timeframe;
  from?: number;
  to?: number;
  file?: string;
  cacheDir?: string;
}): Promise<Candle[]> {
  if (args.file) return loadCandlesFromFile(args.file);

  const { symbol, interval, from, to, cacheDir } = args;
  if (from === undefined || to === undefined) {
    throw new Error('未指定 --file 时，必须提供 --from 与 --to 以联网拉取 K 线');
  }
  if (cacheDir) {
    const p = cachePath(cacheDir, symbol, interval, from, to);
    if (existsSync(p)) return loadCandlesFromFile(p);
  }

  const candles = await fetchFuturesKlines(symbol, interval, from, to);
  if (candles.length === 0) {
    throw new Error(`区间内无 K 线数据（${symbol} ${interval} ${from}~${to}）`);
  }
  if (cacheDir) {
    const p = cachePath(cacheDir, symbol, interval, from, to);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ symbol, interval, from, to, candles }, null, 0));
  }
  return candles;
}
