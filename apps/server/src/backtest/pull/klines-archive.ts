import 'dotenv/config';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { DataSource } from 'typeorm';
import type { Timeframe } from '@ai-trader/shared';
import { axiosTransport } from '../../common/proxy';
import { MarketCandleEntity } from '../../database/entities/market-candle.entity';

/**
 * 从 data.binance.vision 归档下载 K 线并入库（回测台收尾：3 年 1m 数据方案）。
 *
 * 背景：向量化回测以 `config.interval` 逐根 bar 驱动 onTick；实盘恒喂 1m K 线、
 * 每秒决策（见 strategy-runner buildContextFor）。要让回测与实盘同粒度，需把多年
 * 1m K 线灌入 `market_candles`，之后 `interval=1m` 回测可**全程离线**从 DB 读。
 *
 * 归档粒度（月文件，实测 1m 单月 1.8MB / 43200 行）：
 * `.../data/futures/um/monthly/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{YYYY-MM}.zip`
 *
 * CSV 列序（futures um klines）：
 * `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_*,...,ignore`
 * `open_time` 为**毫秒**。部分早期文件无表头 → 按首行是否数字判定是否跳过。
 *
 * 策略（对齐 archive-download 的健壮性）：
 * - **逐月**下载；单月 404（数据未上线）跳过、网络失败重试耗尽记入 failedMonths **不中断**。
 * - **幂等可续传**：`(symbol, market, interval, openTime)` 冲突即 orIgnore 跳过，重跑补全。
 * - 时间过滤：仅保留 `openTime ∈ [from, to]`（月文件可能含区间外边缘）。
 * - 墙钟硬超时 + 代理预检（归档域走代理，直连易被 GFW 干扰）。
 */

const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/klines';
// PG 单查询参数上限 65535；每行 9 列 → 5000×9=45k 安全
const BATCH_SIZE = 5_000;

export interface KlinesArchiveOpts {
  /** 最多处理月数（默认 40，覆盖 3 年 + 余量）；超出截断防止一次跑太久 */
  maxMonths?: number;
  /** 单请求超时（ms），默认 120s（1m 月包 1.8MB，远低于此） */
  timeoutMs?: number;
  /** 进度回调：(month, rowsThisMonth, cumulativeRows) */
  onProgress?: (month: string, rows: number, totalSoFar: number) => void;
}

export interface KlinesArchiveResult {
  /** 本次新写入行数（orIgnore 跳过的已存在行不计） */
  rows: number;
  /** 成功处理（含 0 新增）的月份 */
  months: string[];
  /** 网络失败重试耗尽的月份（可重跑续传，orIgnore 幂等） */
  failedMonths: string[];
}

/** 枚举 [from, to] 覆盖的 UTC 年月列表（含端点所在月），升序，截断到 maxMonths */
export function monthsInRange(from: number, to: number, maxMonths: number): string[] {
  const out: string[] = [];
  const s = new Date(from);
  const e = new Date(to);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth(); // 0-11
  const ey = e.getUTCFullYear();
  const em = e.getUTCMonth();
  while ((y < ey || (y === ey && m <= em)) && out.length < maxMonths) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/**
 * 代理预检：对归档域发短超时 HEAD（10s）。404/403 亦视为链路可达（仅文件不存在）；
 * 底层连接失败（代理宕机/DNS/TLS）才判不可达，避免逐月空耗死 socket。
 */
export async function probeKlinesArchiveReachable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await axios.head(`${BASE_URL}/BTCUSDT/1m/BTCUSDT-1m-1970-01.zip`, {
      timeout: 10_000,
      signal: AbortSignal.timeout(10_000),
      ...axiosTransport(new URL(BASE_URL).hostname),
      validateStatus: () => true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 80) };
  }
}

async function downloadZip(
  month: string,
  symbol: string,
  interval: Timeframe,
  timeoutMs: number,
): Promise<{ status: 'ok'; buf: Buffer } | { status: 'notfound' } | { status: 'failed'; error: string }> {
  const url = `${BASE_URL}/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`;
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        ...axiosTransport(new URL(url).hostname),
      });
      return { status: 'ok', buf: Buffer.from(resp.data) };
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404) return { status: 'notfound' };
      lastErr = (err as Error).message.slice(0, 80);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { status: 'failed', error: lastErr };
}

/**
 * 解析 klines CSV → Candle 行（跳表头 + 区间过滤）。导出供单测直接喂文本。
 * 列序：open_time,open,high,low,close,volume,...（≥6 列）；open_time 毫秒。
 */
export function parseKlinesCsv(
  csv: string,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
): Partial<MarketCandleEntity>[] {
  const lines = csv.split('\n');
  let start = 0;
  if (lines.length > 0 && !/^\d/.test(lines[0])) start = 1; // skip header
  const rows: Partial<MarketCandleEntity>[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 6) continue;
    const openTime = Number(c[0]);
    if (!Number.isFinite(openTime) || openTime < from || openTime > to) continue;
    rows.push({
      symbol,
      market: 'futures' as const,
      interval,
      openTime,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    });
  }
  return rows;
}

/** 分批 orIgnore 入库（避免打满 PG 参数上限）；返回本批插入行数 */
async function insertBatches(
  repo: import('typeorm').Repository<MarketCandleEntity>,
  rows: Partial<MarketCandleEntity>[],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await repo.createQueryBuilder().insert().orIgnore().values(batch).execute();
    n += batch.length;
  }
  return n;
}

/**
 * 主入口：归档下载 + 解析 + 入库。逐月失败不中断（可续传）。
 */
export async function pullKlinesArchive(
  ds: DataSource,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
  opts: KlinesArchiveOpts = {},
): Promise<KlinesArchiveResult> {
  const maxMonths = opts.maxMonths ?? 40;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const months = monthsInRange(from, to, maxMonths);
  const repo = ds.getRepository(MarketCandleEntity);
  let grand = 0;
  const done: string[] = [];
  const failedMonths: string[] = [];

  for (const month of months) {
    const res = await downloadZip(month, symbol, interval, timeoutMs);
    if (res.status === 'notfound') {
      // eslint-disable-next-line no-console
      console.log(`  ${month} 404（归档未上线）跳过`);
      continue;
    }
    if (res.status === 'failed') {
      // eslint-disable-next-line no-console
      console.warn(`  ${month} 下载失败（重试耗尽）：${res.error} → 跳过，下次续传`);
      failedMonths.push(month);
      continue;
    }

    const zip = new AdmZip(res.buf);
    const entries = zip.getEntries();
    if (entries.length === 0) {
      done.push(month);
      continue;
    }
    const csv = entries[0].getData().toString('utf-8');
    const rows = parseKlinesCsv(csv, symbol, interval, from, to);
    const monthRows = await insertBatches(repo, rows);
    grand += monthRows;
    done.push(month);
    opts.onProgress?.(month, monthRows, grand);
  }

  return { rows: grand, months: done, failedMonths };
}
