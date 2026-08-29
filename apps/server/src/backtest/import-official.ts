import { AppDataSource } from '../database/data-source';
import { MarketCandleEntity } from '../database/entities';
import { Candle, type Timeframe } from '@ai-trader/shared';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { axiosTransport } from '../common/proxy';

/**
 * 币安官方月度 K 线数据包导入 CLI（阶段 6）。
 *
 * 数据源：https://data.binance.vision/data/spot/monthly/klines/<symbol>/<interval>/<symbol>-<interval>-<YYYY-MM>.zip
 * 直链下载，不受 REST 限速与回填分页约束，2 年 1m 约 24 个文件几分钟即可入库，
 * 之后回测完全离线，不再依赖代理链路逐批拉取。
 *
 * 用法：
 *   pnpm -F @ai-trader/server import-klines -- --interval=1m --from=2024-08 --to=2026-07 [--symbol=BTCUSDT]
 *
 * 注意：只覆盖完整历史月份；当前月的最新 K 线仍由回测 autoBackfill（REST）补齐。
 */

const BASE = 'https://data.binance.vision';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq !== -1) args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

/** 月度区间展开（含首尾） */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!y || !m || !ty || !tm) throw new Error('--from/--to 格式必须是 YYYY-MM');
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * 解析一行 CSV：open_time, open, high, low, close, volume, ...（只取前 6 列）。
 * 兼容时间戳单位：2025-01 起官方数据包改为微秒，按量级探测换算回毫秒。
 */
function parseRow(line: string): Candle | null {
  const cols = line.split(',');
  if (cols.length < 6) return null;
  let time = Number(cols[0]);
  if (!Number.isFinite(time)) return null;
  if (time > 1e14) time = Math.floor(time / 1000); // 微秒 → 毫秒
  const open = Number(cols[1]);
  const high = Number(cols[2]);
  const low = Number(cols[3]);
  const close = Number(cols[4]);
  const volume = Number(cols[5]);
  if (![open, high, low, close, volume].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const symbol = (args.symbol ?? 'BTCUSDT').toUpperCase();
  const interval = (args.interval ?? '1m') as Timeframe;
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const from = args.from ?? '2024-08';
  const to = args.to ?? thisMonth;
  const months = monthRange(from, to);

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(MarketCandleEntity);
  const http = axios.create({
    baseURL: BASE,
    timeout: 300_000,
    ...axiosTransport(BASE), // 走统一代理出口
  });

  let total = 0;
  for (const ym of months) {
    if (ym === thisMonth) {
      console.log(`跳过当前月 ${ym}（数据不完整，回测时由 REST 自动回填）`);
      continue;
    }
    const path = `/data/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`;
    let zip: AdmZip;
    try {
      const res = await http.get<ArrayBuffer>(path, { responseType: 'arraybuffer' });
      zip = new AdmZip(Buffer.from(res.data));
    } catch (err) {
      // 404 = 该月尚无数据包，跳过；其余错误终止
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        console.log(`跳过 ${ym}：官方数据包不存在（${path}）`);
        continue;
      }
      throw err;
    }

    const entry = zip.getEntries()[0];
    if (!entry) {
      console.warn(`跳过 ${ym}：zip 为空`);
      continue;
    }
    const rows = entry.getData().toString('utf8').split('\n');
    const candles: Candle[] = [];
    for (const line of rows) {
      if (!line) continue;
      const candle = parseRow(line);
      if (candle) candles.push(candle);
    }

    // 分批 orIgnore 入库（幂等：重复导入不产生重复行）
    const BATCH = 5000;
    let inserted = 0;
    for (let i = 0; i < candles.length; i += BATCH) {
      const slice = candles.slice(i, i + BATCH);
      await repo
        .createQueryBuilder()
        .insert()
        .into(MarketCandleEntity)
        .values(
          slice.map((c) => ({
            symbol,
            interval,
            openTime: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
        )
        .orIgnore()
        .execute();
      inserted += slice.length;
    }
    total += inserted;
    console.log(`${ym}：${inserted} 根入库（${candles[0] ? new Date(candles[0].time).toISOString().slice(0, 10) : '-'} ~ ${candles.at(-1) ? new Date(candles.at(-1)!.time).toISOString().slice(0, 10) : '-'}）`);
  }

  console.log(`\n导入完成：${from} ~ ${to} 共 ${total} 根 ${symbol} ${interval} K 线`);
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
