import {
  type BacktestConfig,
  type Candle,
  type SweepCell,
  type SweepResult,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';
import { deflatedSharpe } from './deflated-sharpe';
import { perBarReturns, sharpePerBar } from './stats';

const MAX_SWEEP_COMBOS = 500;

/** 笛卡尔积：{a:[1,2],b:[3]} → [{a:1,b:3},{a:2,b:3}] */
function cartesian(grid: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(grid);
  let acc: Record<string, number>[] = [{}];
  for (const key of keys) {
    const vals = grid[key];
    const next: Record<string, number>[] = [];
    for (const combo of acc) {
      for (const v of vals) next.push({ ...combo, [key]: v });
    }
    acc = next;
  }
  return acc;
}

/**
 * 参数扫描：对网格每组参数在整段历史独立回放，记录指标；
 * 并按 **DSR（试验数=组合数）** 校正「在几百组里挑最优」造成的夏普高估——
 * 挑出来的冠军若 DSR 仍不过阈值，说明那份漂亮只是多重比较的运气。
 */
export async function runSweep(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  grid: Record<string, number[]>,
): Promise<SweepResult> {
  const combos = cartesian(grid);
  if (combos.length === 0) throw new Error('参数网格为空');
  if (combos.length > MAX_SWEEP_COMBOS) {
    throw new Error(`组合数 ${combos.length} 超过上限 ${MAX_SWEEP_COMBOS}，请缩小网格`);
  }

  const warmup = base.warmupBars;

  const runs: { cell: SweepCell; perBar: number; rets: number[] }[] = [];
  for (const params of combos) {
    const config: BacktestConfig = {
      ...base,
      params: { ...(base.params ?? {}), ...params },
    };
    const res = await runBacktestOnCandles(createStrategy(strategyName), config, candles);
    const rets = perBarReturns(res.report.equityCurve.slice(warmup).map((p) => p.equity));
    runs.push({
      cell: { params, metrics: res.report.metrics },
      perBar: sharpePerBar(rets),
      rets,
    });
  }

  // 各组合的 per-bar 夏普作为「多次试验」集合
  const trialSharpes = runs.map((r) => r.perBar);

  for (const r of runs) {
    r.cell.dsr = deflatedSharpe({
      obsSharpe: r.perBar,
      trialSharpes,
      obsReturns: r.rets,
    });
  }

  // 最优：per-bar 夏普最高者（与前端高亮一致）
  let bestIndex = 0;
  for (let i = 1; i < runs.length; i += 1) {
    if (runs[i].perBar > runs[bestIndex].perBar) bestIndex = i;
  }

  const cells: SweepCell[] = runs.map((r) => r.cell);
  return {
    gridKeys: Object.keys(grid),
    cells,
    combos: combos.length,
    bestIndex,
  };
}
