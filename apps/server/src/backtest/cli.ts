import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppDataSource } from '../database/data-source';
import { MarketCandleEntity } from '../database/entities';
import { strategyRegistry, type Timeframe } from '@ai-trader/shared';
import { backfill, loadRange } from './candle-source';
import { runBacktest } from './engine';
import type { BacktestConfig } from './types';

/**
 * 回测 CLI。
 *
 * 用法：
 *   pnpm -F @ai-trader/server backtest -- --strategy=trend_following \
 *     --interval=5m --from=2026-06-01 --to=2026-08-01 [--backfill] \
 *     [--capital=10000] [--position-pct=0.1] [--min-confidence=0.6]
 *
 * 数据不足时自动回填（Binance 公共 REST，无需密钥）。
 * 报告落盘 apps/server/reports/backtest/，终端输出摘要。
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return args;
}

function ts(label: string): number {
  return new Date(label).getTime();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const symbol = String(args.symbol ?? 'BTCUSDT');
  const interval = String(args.interval ?? '5m') as Timeframe;
  const from = ts(String(args.from ?? '2026-06-01'));
  const to = ts(String(args.to ?? new Date().toISOString().slice(0, 10)));
  if (!(from < to)) throw new Error('--from 必须早于 --to');

  const config: BacktestConfig = {
    symbol,
    interval,
    from,
    to,
    initialCapital: Number(args.capital ?? 10_000),
    slippageBps: Number(args.slippage ?? 5),
    feeRateBps: Number(args.fee ?? 10),
    positionPct: Number(args['position-pct'] ?? 0.1),
    minConfidence: Number(args['min-confidence'] ?? 0.6),
    strategyName: String(args.strategy ?? 'trend_following'),
    strategyParams: args.params ? JSON.parse(String(args.params)) : undefined,
    warmupBars: Number(args.warmup ?? 120),
  };

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(MarketCandleEntity);

  let candles = await loadRange(repo, symbol, interval, from, to);
  // 稀疏检测：库内根数明显少于区间应有根数时回填（仅按 warmup 判断会在大区间小库时漏填）
  const intervalMatch = /^(\d+)([mhd])$/.exec(interval);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const stepMs = intervalMatch
    ? Number(intervalMatch[1]) * (unitMs[intervalMatch[2] as keyof typeof unitMs] ?? 60_000)
    : 300_000;
  const expectedBars = Math.floor((to - from) / stepMs) + 1;
  if (candles.length < expectedBars * 0.9) {
    console.log(
      `库内 ${symbol} ${interval} 区间内仅 ${candles.length}/${expectedBars} 根，回填 ${new Date(from).toISOString()} ~ ${new Date(to).toISOString()} …`,
    );
    const inserted = await backfill(repo, symbol, interval, from, to);
    console.log(`回填完成，新插入 ${inserted} 根`);
    candles = await loadRange(repo, symbol, interval, from, to);
  }
  if (candles.length <= config.warmupBars + 2) {
    throw new Error(`K 线数据不足（${candles.length} 根），无法回测`);
  }

  const { strategy, fellBack } = strategyRegistry.getOrDefault(config.strategyName);
  if (fellBack) console.warn(`策略 ${config.strategyName} 不存在，使用 trend_following`);

  console.log(
    `回测 ${symbol} ${interval}，${candles.length} 根（${new Date(candles[0].time).toISOString()} ~ ` +
      `${new Date(candles.at(-1)!.time).toISOString()}），策略=${strategy.name}`,
  );

  const report = runBacktest(candles, strategy, config);

  // 报告落盘（meta 不含生成时间戳，保证确定性可 diff）
  const outDir = resolve(process.cwd(), 'reports/backtest');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${strategy.name}-${interval}.json`;
  const outPath = resolve(outDir, fileName);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.table({
    总收益率: `${report.metrics.totalReturnPct}%`,
    年化收益率: `${report.metrics.annualizedReturnPct}%`,
    最大回撤: `${report.metrics.maxDrawdownPct}%`,
    夏普比率: report.metrics.sharpeRatio,
    胜率: `${(report.metrics.winRate * 100).toFixed(1)}%`,
    盈亏比: report.metrics.profitFactor === Infinity ? '∞' : report.metrics.profitFactor,
    交易次数: report.metrics.tradeCount,
    BuyHold收益率: `${report.metrics.buyHoldReturnPct}%`,
    超额收益: `${report.metrics.excessVsBuyHoldPct}%`,
  });
  console.log(`报告已写入 ${outPath}`);

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
