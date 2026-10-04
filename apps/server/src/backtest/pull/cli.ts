/**
 * 历史数据拉取 CLI（P1-A3）。
 *
 * 用法：
 *   pnpm --filter @ai-trader/server pull-history -- --symbol BTCUSDT --from 2026-06-01 --to 2026-09-01 --only meta,funding,markprice,oi
 *
 * --only 缺省 = `meta,funding,markprice,oi`（aggTrades 数据量大，须显式指定；1 月 BTCUSDT
 * 约 6-10M 条）。--check 单独跑质检不写入。
 *
 * 设计原则：
 * - **幂等**：反复跑同一区间不产生重复（upsert）
 * - **可中断**：每步落库；下次从缺的部分继续（count 检查会体现在质检里）
 * - **不进 event-driven 主流程**：只是数据搬运，撮合引擎通过 DB 消费
 */
import 'dotenv/config';
import { AppDataSource } from '../../database/data-source';
import {
  pullAggTrades,
  pullFundingRates,
  pullMarkPriceKlines,
  pullOpenInterestHist,
  pullSymbolMeta,
} from './history-pull';
import { pullAggTradesArchive, probeArchiveReachable } from './archive-download';
import { pullKlinesArchive, probeKlinesArchiveReachable } from './klines-archive';
import { assertDataQuality, formatQualityReport } from './data-quality';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function toMs(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${v}`);
  return t;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const symbol = (args.symbol ?? 'BTCUSDT').toUpperCase();
  const now = Date.now();
  const to = toMs(args.to, now);
  const from = toMs(args.from, to - 30 * 86_400_000);
  const only = (args.only ?? 'meta,funding,markprice,oi')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!AppDataSource.isInitialized) await AppDataSource.initialize();

  const steps: string[] = [];
  try {
    if (args.check === 'true') {
      const requireAgg = only.includes('aggtrades') || only.includes('agg') || only.includes('archive');
      const report = await assertDataQuality(AppDataSource, symbol, from, to, {
        requireAggTrades: requireAgg,
      });
      // eslint-disable-next-line no-console
      console.log(formatQualityReport(report));
      if (!report.ok) process.exitCode = 2;
      return;
    }

    if (only.includes('meta')) {
      const n = await pullSymbolMeta(AppDataSource, symbol);
      steps.push(`meta: upsert ${n}`);
    }
    if (only.includes('funding')) {
      const n = await pullFundingRates(AppDataSource, symbol, from, to);
      steps.push(`funding: upsert ${n}`);
    }
    if (only.includes('markprice')) {
      const n = await pullMarkPriceKlines(AppDataSource, symbol, from, to, '1m');
      steps.push(`markPrice: upsert ${n}`);
    }
    if (only.includes('oi')) {
      const n = await pullOpenInterestHist(AppDataSource, symbol, from, to, '5m');
      steps.push(`openInterest: upsert ${n}（Binance 限近 30 天）`);
    }
    if (only.includes('agg') || only.includes('aggtrades')) {
      const n = await pullAggTrades(AppDataSource, symbol, from, to);
      steps.push(`aggTrades (REST): upsert ${n}`);
    }
    if (only.includes('klines') || only.includes('klines-archive')) {
      // K 线归档（月 zip）灌入 market_candles：向量化回测与实盘同粒度（1m）的离线数据底座。
      const interval = (args.interval ?? '1m') as import('@ai-trader/shared').Timeframe;
      const preflight = await probeKlinesArchiveReachable();
      if (!preflight.ok) {
        throw new Error(`K 线归档代理不可达（${preflight.reason}）——请确认本地代理已启动后重试`);
      }
      const r = await pullKlinesArchive(AppDataSource, symbol, interval, from, to, {
        maxMonths: args['max-months'] ? Number(args['max-months']) : undefined,
        timeoutMs: args['timeout'] ? Number(args['timeout']) : undefined,
        onProgress: (month, rows, total) => {
          // eslint-disable-next-line no-console
          console.log(`  · klines ${month}: ${rows} rows (cumulative ${total})`);
        },
      });
      steps.push(
        `klines (archive ${interval}): upsert ${r.rows} rows / ${r.months.length} 月` +
          (r.failedMonths.length ? ` / 失败 ${r.failedMonths.length} 月 [${r.failedMonths.join(',')}] 可重跑续传` : ''),
      );
    }

    if (only.includes('archive')) {
      // 代理预检：归档域走代理，不通则快速失败而非逐日空耗（避免 hang 在死 socket）
      const preflight = await probeArchiveReachable();
      if (!preflight.ok) {
        throw new Error(`归档代理不可达（${preflight.reason}）——请确认本地代理已启动后重试`);
      }
      const r = await pullAggTradesArchive(AppDataSource, symbol, from, to, {
        maxDays: args['max-days'] ? Number(args['max-days']) : undefined,
        timeoutMs: args['timeout'] ? Number(args['timeout']) : undefined,
        onProgress: (day, rows, total) => {
          // eslint-disable-next-line no-console
          console.log(`  · archive ${day}: ${rows} rows (cumulative ${total})`);
        },
      });
      steps.push(
        `aggTrades (archive): upsert ${r.rows} rows / ${r.days} days` +
          (r.failedDays.length ? ` / 失败 ${r.failedDays.length} 天 [${r.failedDays.join(',')}] 可重跑续传` : ''),
      );
    }

    const requireAgg2 = only.includes('aggtrades') || only.includes('agg') || only.includes('archive');
    const report = await assertDataQuality(AppDataSource, symbol, from, to, {
      requireAggTrades: requireAgg2,
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        `拉取历史数据 ${symbol} [${new Date(from).toISOString()} → ${new Date(to).toISOString()}]`,
        ...steps.map((s) => `  · ${s}`),
        formatQualityReport(report),
      ].join('\n'),
    );
    if (!report.ok) process.exitCode = 2;
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('拉取失败：', (err as Error).message);
  process.exit(1);
});
