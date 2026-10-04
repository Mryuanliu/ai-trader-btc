import 'dotenv/config';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { DataSource } from 'typeorm';
import { axiosTransport } from '../../common/proxy';
import { MarketAggTradeEntity } from '../../database/entities/market-agg-trade.entity';

/**
 * 从 data.binance.vision 归档下载 aggTrades 并入库（P1b）。
 *
 * 背景：Binance REST `/fapi/v1/aggTrades` 已限制仅允许查最近 2 天，
 * 历史数据必须走官方归档（S3/CloudFront）。归档粒度：
 * - 日文件：`.../daily/aggTrades/{SYMBOL}/{SYMBOL}-aggTrades-{YYYY-MM-DD}.zip`
 * - 月文件：`.../monthly/aggTrades/{SYMBOL}/{SYMBOL}-aggTrades-{YYYY-MM}.zip`
 *
 * CSV 格式（futures um aggTrades,含 header）：
 * ```
 * agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
 * ```
 * `transact_time` 为 **毫秒**（验证确认 2026-09-28 归档）。
 *
 * 策略：
 * - 按日粒度（zip 约 5-20MB，解压 CSV 约 50-150MB → adm-zip 一次性进内存 + 逐行解析）。
 * - 每 `BATCH` 条 upsert（默认 10000）；跨日之间串行（避免 DB 连接池打满）。
 * - **幂等**：`(symbol, market, aggTradeId)` 冲突即覆盖；重复跑安全。
 * - 时间过滤：只 upsert `tradeTime ∈ [from, to]` 的行（日文件含 0~24 整点全天）。
 * - 失败重试：下载 3 次；404（数据未上线）→ 跳过 + warn。
 */

const BASE_URL = 'https://data.binance.vision/data/futures/um/daily/aggTrades';
const BATCH_SIZE = 2_000; // PG 协议单查询参数上限 65535；upsert 每行约 20 参数(insert+update) → 2000×20=40k 安全
const DAY_MS = 86_400_000;

export interface ArchiveDownloadOpts {
  /** 最多下载天数（默认 30）；超出截断，防止一次性跑太久 */
  maxDays?: number;
  /** 请求超时（ms），默认 120s */
  timeoutMs?: number;
  /** 进度回调 */
  onProgress?: (day: string, rows: number, totalSoFar: number) => void;
}

/** 枚举 [from, to] 覆盖的 UTC 日期列表（含端点所在天） */
function datesInRange(from: number, to: number, maxDays: number): string[] {
  const out: string[] = [];
  const start = Math.floor(from / DAY_MS) * DAY_MS;
  const end = Math.floor(to / DAY_MS) * DAY_MS;
  for (let t = start; t <= end && out.length < maxDays; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10)); // 'YYYY-MM-DD'
  }
  return out;
}

/**
 * 代理预检：对归档域发一个短超时 HEAD 请求（10s）。
 * 404/403 也算“可达”（说明网络/代理链路通，只是该文件不存在）；
 * 仅当底层连接失败（代理宕机/DNS/TLS）才判不可达。
 */
export async function probeArchiveReachable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await axios.head(`${BASE_URL}/BTCUSDT/BTCUSDT-aggTrades-1970-01-01.zip`, {
      timeout: 10_000,
      signal: AbortSignal.timeout(10_000),
      ...axiosTransport(new URL(BASE_URL).hostname),
      validateStatus: () => true, // 任何状态码都视为链路可达
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 80) };
  }
}

async function downloadZip(
  date: string,
  symbol: string,
  timeoutMs: number,
): Promise<{ status: 'ok'; buf: Buffer } | { status: 'notfound' } | { status: 'failed'; error: string }> {
  const url = `${BASE_URL}/${symbol}/${symbol}-aggTrades-${date}.zip`;
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        // 墙钟绝对超时：即使代理保持 hang socket 也会中断（axios timeout 仅管 socket inactivity）
        signal: AbortSignal.timeout(timeoutMs),
        ...axiosTransport(new URL(url).hostname),
      });
      return { status: 'ok', buf: Buffer.from(resp.data) };
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404) return { status: 'notfound' }; // 该日数据未上线
      lastErr = (err as Error).message.slice(0, 80);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { status: 'failed', error: lastErr };
}


/**
 * 主入口：归档下载 + 解析 + 入库。
 */
export interface ArchivePullResult {
  /** 本次新写入行数（orIgnore 跳过的已存在行不计） */
  rows: number;
  /** 处理完整的天数 */
  days: number;
  /** 网络失败重试耗尽的天数（可重跑续传，orIgnore 幂等） */
  failedDays: string[];
}

export async function pullAggTradesArchive(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
  opts: ArchiveDownloadOpts = {},
): Promise<ArchivePullResult> {
  const maxDays = opts.maxDays ?? 30;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const dates = datesInRange(from, to, maxDays);
  const repo = ds.getRepository(MarketAggTradeEntity);
  let grand = 0;
  let days = 0;
  const failedDays: string[] = [];

  for (const date of dates) {
    const res = await downloadZip(date, symbol, timeoutMs);
    if (res.status === 'notfound') {
      // eslint-disable-next-line no-console
      console.log(`  ${date} 404（归档未上线）跳过`);
      continue;
    }
    if (res.status === 'failed') {
      // 单日失败不阻断整体：记录后续跑 orIgnore 幂等续传
      // eslint-disable-next-line no-console
      console.warn(`  ${date} 下载失败（重试耗尽）：${res.error} → 跳过，下次续传`);
      failedDays.push(date);
      continue;
    }
    const buf = res.buf;

    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    if (entries.length === 0) continue;

    const csv = entries[0].getData().toString('utf-8');
    const lines = csv.split('\n');

    // 检测 header（第一行含 alpha 非数字开头）
    let startLine = 0;
    if (lines.length > 0 && !/^\d/.test(lines[0])) {
      startLine = 1; // skip header
    }

    let batch: Partial<MarketAggTradeEntity>[] = [];
    let dayRows = 0;

    for (let i = startLine; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length < 7) continue;
      const aggTradeId = Number(cols[0]);
      const price = Number(cols[1]);
      const qty = Number(cols[2]);
      const firstId = Number(cols[3]);
      const lastId = Number(cols[4]);
      const tradeTime = Number(cols[5]);
      const isBuyerMaker = cols[6] === 'true';

      // 时间窗口过滤（日文件含整天，可能跨 from/to 边界）
      if (tradeTime < from || tradeTime > to) continue;

      batch.push({
        symbol,
        market: 'futures' as const,
        aggTradeId,
        tradeTime,
        price,
        qty,
        quoteQty: price * qty,
        isBuyerMaker,
        firstId,
        lastId,
      });

      if (batch.length >= BATCH_SIZE) {
        await repo
          .createQueryBuilder()
          .insert()
          .orIgnore()
          .values(batch)
          .execute();
        dayRows += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      // 确保末尾残余也不超 PG 参数上限
      while (batch.length > 0) {
        const slice = batch.splice(0, BATCH_SIZE);
        await repo
          .createQueryBuilder()
          .insert()
          .orIgnore()
          .values(slice)
          .execute();
        dayRows += slice.length;
      }
    }

    grand += dayRows;
    days += 1;
    opts.onProgress?.(date, dayRows, grand);
  }

  return { rows: grand, days, failedDays };
}
