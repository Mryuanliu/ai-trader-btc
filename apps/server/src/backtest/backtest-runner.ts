import {
  atr,
  computePerformance,
  TIMEFRAME_MS,
  type Candle,
} from '@ai-trader/shared';
import type { StrategyContext, TradingStrategy } from '../strategy/types';
import { SimBroker } from './sim-broker';
import { loadHistoricalCandles } from './historical-feed';
import type { BacktestConfig, BacktestMetrics, BacktestReport, BacktestResult, EquityPoint } from './backtest.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造 ctx 时携带的回看 K 线根数（够算长均线/ATR 并留余量） */
const CONTEXT_LOOKBACK = 300;

function computeAtr(candles: Candle[]): number {
  if (candles.length < 20) return 0;
  const v = atr(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    candles.map((c) => c.close),
    14,
  );
  return Number.isFinite(v) ? v : 0;
}

/**
 * 回测入口：按 config 载入历史 K 线（文件/缓存/联网），再交给 runBacktestOnCandles 回放。
 */
export async function runBacktest(
  strategy: TradingStrategy,
  config: BacktestConfig,
): Promise<BacktestResult> {
  const candles = await loadHistoricalCandles({
    symbol: config.symbol,
    interval: config.interval,
    from: config.from,
    to: config.to,
    file: config.file,
    cacheDir: config.cacheDir,
  });
  return runBacktestOnCandles(strategy, config, candles);
}

/**
 * 回测主循环：**逐根 bar 驱动 SimBroker，用历史 K 线构造与实盘同构的 StrategyContext，
 * 调用 `strategy.onTick(ctx, broker)`——策略代码一行不改即可回放（parity）。
 *
 * 拆成接受预载 candles 的形式，供 walk-forward / CPCV / sweep 复用同一份数据切窗回放，
 * 避免每扇窗口重复拉盘。
 */
export async function runBacktestOnCandles(
  strategy: TradingStrategy,
  config: BacktestConfig,
  candles: Candle[],
): Promise<BacktestResult> {
  if (candles.length <= config.warmupBars) {
    throw new Error(`K 线仅 ${candles.length} 根，不足以预热 ${config.warmupBars} 根`);
  }

  const params = strategy.normalizeParams(config.params ?? {});
  strategy.onStart?.(params);

  const intervalMs = TIMEFRAME_MS[config.interval];
  const instanceId = `${config.strategyName}:${config.symbol}`;
  const broker = new SimBroker({
    symbol: config.symbol,
    instanceId,
    initialCapital: config.initialCapital,
    feeRate: config.feeRateBps / 10_000,
    slippage: config.slippageBps / 10_000,
    fundingPctPer8h: config.fundingPctPer8h,
    intervalMs,
  });

  const equityCurve: EquityPoint[] = [];
  let peak = config.initialCapital;
  let maxDrawdownPct = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i];
    // 撮合：兑现上根受理的市价单 + 触发挂起 STOP + 分摊资金费
    broker.beginBar(bar);

    const mark = bar.close;
    if (i >= config.warmupBars) {
      const window = candles.slice(Math.max(0, i + 1 - CONTEXT_LOOKBACK), i + 1);
      const ctx: StrategyContext = {
        instanceId,
        symbol: config.symbol,
        price: mark,
        markPrice: mark,
        atr: computeAtr(window),
        candles: window,
        openLots: broker.lotViews(mark),
        openOrders: broker.orderViews(),
        availableMargin: broker.equity(mark),
        netQty: broker.netQty(),
        params,
        now: bar.time,
      };
      await strategy.onTick(ctx, broker);
    }

    const equity = broker.equity(mark);
    peak = Math.max(peak, equity);
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
    equityCurve.push({ time: bar.time, equity: Number(equity.toFixed(8)), drawdownPct: Number(ddPct.toFixed(4)) });
  }

  const finalMark = candles[candles.length - 1].close;
  const finalEquity = broker.equity(finalMark);
  const { rounds, costs } = broker.finalize();
  const basketMetrics = computePerformance(config.strategyName, config.symbol, 'all', rounds);

  // 买入持有基准（1x，不计费）：首个可交易日收盘 → 末根收盘
  const firstClose = candles[config.warmupBars].close;
  const buyHoldReturnPct = ((finalMark - firstClose) / firstClose) * 100;
  const totalReturnPct = ((finalEquity - config.initialCapital) / config.initialCapital) * 100;
  const spanMs = candles[candles.length - 1].time - candles[config.warmupBars].time;
  const spanDays = Math.max(1, spanMs / DAY_MS);
  const annualizedReturnPct =
    finalEquity > 0
      ? (Math.pow(finalEquity / config.initialCapital, 365 / spanDays) - 1) * 100
      : -100;

  const openFillCount = broker.trades.filter((t) => t.kind === 'OPEN').length;
  const metrics: BacktestMetrics = {
    totalReturnPct: Number(totalReturnPct.toFixed(4)),
    annualizedReturnPct: Number(annualizedReturnPct.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    // 与实盘 performance.service 完全同口径（日聚合已实现收益 ×√365）
    sharpeRatio: basketMetrics.sharpe,
    winRate: basketMetrics.winRate,
    profitFactor: basketMetrics.profitFactor,
    tradeCount: openFillCount,
    buyHoldReturnPct: Number(buyHoldReturnPct.toFixed(4)),
    excessVsBuyHoldPct: Number((totalReturnPct - buyHoldReturnPct).toFixed(4)),
  };

  const report: BacktestReport = {
    meta: {
      symbol: config.symbol,
      interval: config.interval,
      from: candles[0].time,
      to: candles[candles.length - 1].time,
      candleCount: candles.length,
      warmupBars: config.warmupBars,
      initialCapital: config.initialCapital,
      slippageBps: config.slippageBps,
      feeRateBps: config.feeRateBps,
      fundingPctPer8h: config.fundingPctPer8h,
      strategyName: config.strategyName,
      strategyParams: params,
      fillConvention: 'next-open',
      generatedAt: new Date().toISOString(),
    },
    metrics,
    basketMetrics,
    costBreakdown: costs,
    equityCurve,
    trades: broker.trades,
  };

  strategy.onStop?.();
  return { candles, config, report, rounds };
}
