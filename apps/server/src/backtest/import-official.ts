/**
 * K 线下载器（`pnpm --filter @ai-trader/server import-klines -- --symbol BTCUSDT --interval 5m --from ... --to ... --out ...`）。
 *
 * 从币安公共行情端点批量拉取历史 K 线，落成一个 JSON 文件，供 `backtest --file` 离线复跑
 * （避免每次回测都联网）。默认写进 reports/backtest/data/ 缓存目录。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TIMEFRAMES, type Timeframe } from '@ai-trader/shared';
import { fetchFuturesKlines } from './historical-feed';

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
      }
    }
  }
  return out;
}

function toMs(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${v}`);
  return t;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const symbol = (args.symbol ?? 'BTCUSDT').toUpperCase();
  const interval = (args.interval ?? '5m') as Timeframe;
  if (!(TIMEFRAMES as readonly string[]).includes(interval)) {
    throw new Error(`非法周期：${interval}`);
  }
  if (!args.from || !args.to) throw new Error('必须提供 --from 与 --to');
  const from = toMs(args.from);
  const to = toMs(args.to);

  const candles = await fetchFuturesKlines(symbol, interval, from, to);
  const outFile =
    args.out ?? join('reports/backtest/data', `${symbol}-${interval}-${from}-${to}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ symbol, interval, from, to, candles }, null, 0));

  // eslint-disable-next-line no-console
  console.log(`已拉取 ${symbol} ${interval} K 线 ${candles.length} 根 → ${outFile}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('下载失败：', (err as Error).message);
  process.exit(1);
});
