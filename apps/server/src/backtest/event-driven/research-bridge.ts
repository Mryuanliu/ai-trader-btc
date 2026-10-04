import {
  TIMEFRAME_MS,
  type BacktestConfig,
  type EquityPoint,
  type WalkForwardResult,
  type WalkForwardSegment,
} from '@ai-trader/shared';
import {
  annualizeSharpe,
  maxDrawdownPct,
  mean,
  perBarReturns,
  sharpePerBar,
} from '../research/stats';

/**
 * 从 event-driven 完整回测产出的 equityCurve **近似** walk-forward。
 *
 * 与真实 WF 的区别（诚实标注）：
 * - 真实 WF：每窗 fresh 策略实例（onStart 重新初始化内部状态 → 无前窗残留）
 * - 近似 WF：只跑一次完整 event-driven → equity 切段 → 各段独立算 Sharpe
 * - **等价条件**：策略无跨窗状态（donchian/mean_reversion 是 fresh-per-bar 的指标驱动型，无内部计数器）；
 *   马丁类有篮子累积状态 → 近似偏差更大，但 equity 切段仍是保守下界（不美化）。
 *
 * 优势：只需一次 event-driven 全量回放（3M+ 笔逐笔），免去 N 窗 × 百万笔的重复 IO → 从数小时降到分钟级。
 */
export interface ApproxWFOptions {
  trainBars: number;
  testBars: number;
  stepBars?: number;
  warmupBars: number;
}

export function approximateWalkForward(
  equityCurve: EquityPoint[],
  config: BacktestConfig,
  opts: ApproxWFOptions,
): WalkForwardResult {
  const { trainBars, testBars, warmupBars } = opts;
  const step = opts.stepBars ?? testBars;
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[config.interval];
  const region = equityCurve.length - warmupBars;
  if (region < trainBars + testBars) {
    throw new Error(
      `近似 WF 决策区仅 ${region} 根，不足 train=${trainBars}+test=${testBars}`,
    );
  }

  const segments: WalkForwardSegment[] = [];
  const allOosEquity: EquityPoint[] = [];

  for (let offset = 0; offset + trainBars + testBars <= region; offset += step) {
    const trainFrom = warmupBars + offset;
    const trainTo = trainFrom + trainBars;
    const testFrom = trainTo;
    const testTo = testFrom + testBars;

    const isSeg = equityCurve.slice(trainFrom, trainTo);
    const oosSeg = equityCurve.slice(testFrom, testTo);

    const isRets = perBarReturns(isSeg.map((p) => p.equity));
    const oosRets = perBarReturns(oosSeg.map((p) => p.equity));

    const isSharpe = isRets.length > 1 ? annualizeSharpe(sharpePerBar(isRets), barsPerYear) : 0;
    const oosSharpe = oosRets.length > 1 ? annualizeSharpe(sharpePerBar(oosRets), barsPerYear) : 0;

    segments.push({
      index: segments.length,
      trainFrom: isSeg[0]?.time ?? 0,
      trainTo: isSeg[isSeg.length - 1]?.time ?? 0,
      testFrom: oosSeg[0]?.time ?? 0,
      testTo: oosSeg[oosSeg.length - 1]?.time ?? 0,
      isSharpe: Number(isSharpe.toFixed(6)),
      isTotalReturnPct: isSeg.length > 1
        ? Number((((isSeg[isSeg.length - 1].equity - isSeg[0].equity) / isSeg[0].equity) * 100).toFixed(4))
        : 0,
      oosSharpe: Number(oosSharpe.toFixed(6)),
      oosTotalReturnPct: oosSeg.length > 1
        ? Number((((oosSeg[oosSeg.length - 1].equity - oosSeg[0].equity) / oosSeg[0].equity) * 100).toFixed(4))
        : 0,
      oosTradeCount: 0,
    });

    allOosEquity.push(...oosSeg);
  }

  if (segments.length === 0) {
    throw new Error('近似 WF 产不出任何窗口（数据过短）');
  }

  // 拼接 OOS → 指标（直接用 EquityPoint[] 无需 equityPath）
  const oosEquity = allOosEquity;
  const oosRets = perBarReturns(allOosEquity.map((p) => p.equity));
  const aggregateOosSharpe =
    oosRets.length > 1
      ? Number(annualizeSharpe(sharpePerBar(oosRets), barsPerYear).toFixed(6))
      : 0;
  const aggregateIsSharpe = Number(
    mean(segments.map((s) => s.isSharpe)).toFixed(6),
  );
  const oosTotalReturnPct = Number(
    (allOosEquity.length > 1
      ? ((allOosEquity[allOosEquity.length - 1].equity - allOosEquity[0].equity) / allOosEquity[0].equity) * 100
      : 0
    ).toFixed(4),
  );
  const oosMaxDrawdownPct = maxDrawdownPct(allOosEquity.map((p) => p.equity));

  return {
    trainBars,
    testBars,
    stepBars: step,
    segments,
    oosEquity,
    aggregateOosSharpe,
    aggregateIsSharpe,
    oosTotalReturnPct,
    oosMaxDrawdownPct,
    oosWinRate: 0, // 近似 WF 无法从 equity 曲线推胜率
    oosProfitFactor: null, // 同上
    oosTradeCount: 0,
  };
}
