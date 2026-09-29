import {
  TIMEFRAME_MS,
  computePerformance,
  type BacktestConfig,
  type Candle,
  type EquityPoint,
  type PerfRound,
  type WalkForwardResult,
  type WalkForwardSegment,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';
import {
  annualizeSharpe,
  equityPath,
  maxDrawdownPct,
  mean,
  perBarReturns,
  sharpePerBar,
} from './stats';

export interface WalkForwardOptions {
  /** 每窗训练（IS）根数 */
  trainBars: number;
  /** 每窗测试（OOS）根数 */
  testBars: number;
  /** 滚动步长，默认 = testBars（OOS 不重叠） */
  stepBars?: number;
}

/** 截取决策区（去掉 warmup 前缀）后的净值序列 → 逐根收益 */
function decisionReturns(equityCurve: EquityPoint[], warmup: number): number[] {
  const vals = equityCurve.slice(warmup).map((p) => p.equity);
  return perBarReturns(vals);
}

/**
 * Walk-forward：把决策时间轴切成连续的 train/test 窗口，每窗用**全新策略实例**独立回放，
 * 只统计落在 OOS 区间的净值，再把各窗 OOS 收益拼接成一条样本外曲线。
 *
 * 为什么权威：策略参数是全历史「看着调」的，用 train 段当 IS、紧随其后的 test 段当 OOS，
 * 才能暴露「调参对未来的真实外推能力」。拼接后的 OOS Sharpe 通常显著低于全样本 IS ——
 * 这正是拦住 Sharpe5.53 幻觉的那一刀。
 */
export async function walkForward(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  opts: WalkForwardOptions,
): Promise<WalkForwardResult> {
  const warmup = base.warmupBars;
  const { trainBars, testBars } = opts;
  const step = opts.stepBars ?? testBars;
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[base.interval];

  const segments: WalkForwardSegment[] = [];
  const oosRets: number[] = [];
  const oosRounds: PerfRound[] = [];
  const isAnnualSharpe: number[] = [];
  let oosTradeCount = 0;

  let idx = 0;
  for (let end = warmup + trainBars; end + testBars <= candles.length; end += step) {
    const trainSlice = candles.slice(end - trainBars, end);
    const testSlice = candles.slice(Math.max(0, end - warmup), end + testBars);
    const isRes = await runBacktestOnCandles(createStrategy(strategyName), { ...base }, trainSlice);
    const oosRes = await runBacktestOnCandles(createStrategy(strategyName), { ...base }, testSlice);

    const isRet = decisionReturns(isRes.report.equityCurve, warmup);
    const oosRet = decisionReturns(oosRes.report.equityCurve, warmup);
    oosRets.push(...oosRet);
    oosRounds.push(...oosRes.rounds);
    oosTradeCount += oosRes.report.metrics.tradeCount;

    const isAnn = annualizeSharpe(sharpePerBar(isRet), barsPerYear);
    isAnnualSharpe.push(isAnn);

    segments.push({
      index: idx,
      trainFrom: candles[end - trainBars].time,
      trainTo: candles[end - 1].time,
      testFrom: candles[end].time,
      testTo: candles[end + testBars - 1].time,
      isSharpe: Number(isAnn.toFixed(4)),
      isTotalReturnPct: isRes.report.metrics.totalReturnPct,
      oosSharpe: Number(annualizeSharpe(sharpePerBar(oosRet), barsPerYear).toFixed(4)),
      oosTotalReturnPct: oosRes.report.metrics.totalReturnPct,
      oosTradeCount: oosRes.report.metrics.tradeCount,
    });
    idx += 1;
  }

  if (segments.length === 0) {
    throw new Error(
      `数据不足以切出 walk-forward 窗口（candles=${candles.length}, warmup=${warmup}, train=${trainBars}, test=${testBars}）`,
    );
  }

  // 拼接 OOS 净值：从初始本金按各窗 OOS 逐根收益累乘
  const path = equityPath(base.initialCapital, oosRets);
  // 净值点用序号映射到首段 testFrom（前端只画形状，时间轴是等间隔近似）
  const firstTestFrom = segments[0].testFrom;
  const intervalMs = TIMEFRAME_MS[base.interval];
  let runPeak = path[0];
  const oosEquity: EquityPoint[] = path.map((e, i) => {
    if (e > runPeak) runPeak = e;
    const dd = runPeak > 0 ? ((runPeak - e) / runPeak) * 100 : 0;
    return {
      time: firstTestFrom + i * intervalMs,
      equity: Number(e.toFixed(8)),
      drawdownPct: Number(dd.toFixed(4)),
    };
  });

  const agg = computePerformance(`${strategyName}:oos`, base.symbol, 'all', oosRounds);

  return {
    trainBars,
    testBars,
    stepBars: step,
    segments,
    oosEquity,
    aggregateIsSharpe: Number(mean(isAnnualSharpe).toFixed(4)),
    aggregateOosSharpe: Number(annualizeSharpe(sharpePerBar(oosRets), barsPerYear).toFixed(4)),
    oosTotalReturnPct: Number(((path[path.length - 1] / base.initialCapital - 1) * 100).toFixed(4)),
    oosMaxDrawdownPct: Number(maxDrawdownPct(path).toFixed(4)),
    oosWinRate: agg.winRate,
    oosProfitFactor: agg.profitFactor,
    oosTradeCount,
  };
}
