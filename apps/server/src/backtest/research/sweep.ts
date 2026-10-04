import {
  type BacktestConfig,
  type Candle,
  type SweepCell,
  type SweepResult,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';
import { deflatedSharpe } from './deflated-sharpe';
import { computePlateau } from './plateau';
import { pboFromReturns } from './pbo';
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
export interface SweepOptions {
  /** 计算全组合 CSCV-PBO；给定 nSubsets（默认 16），组合数<2 时自动跳过 */
  pbo?: { nSubsets?: number };
}

export async function runSweep(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  grid: Record<string, number[]>,
  opts: SweepOptions = {},
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

  // 各组合的 per-bar 夏普作为「多次试验」集合（同时供 plateau 邻域比较）
  const trialSharpes = runs.map((r) => r.perBar);

  for (const [i, r] of runs.entries()) {
    r.cell.dsr = deflatedSharpe({
      obsSharpe: r.perBar,
      trialSharpes,
      obsReturns: r.rets,
    });
    // 参数高原：以该组为冠军看网格邻域（±1 step）掉幅
    r.cell.plateau = computePlateau({ grid, combos, sharpes: trialSharpes, bestIndex: i });
  }

  // 最优：per-bar 夏普最高者，但**只在有成交（笔数>0）的组合里选**——
  // 0 笔退化组合（全被过滤/无信号）的 per-bar 夏普为 0，会虚假地胜过实际亏损的有效组合。
  // 若全部 0 笔（极端网格），再回退到全体 per-bar argmax。
  const pool = runs.map((_, i) => i).filter((i) => runs[i].cell.metrics.tradeCount > 0);
  const cand = pool.length ? pool : runs.map((_, i) => i);
  let bestIndex = cand[0];
  for (const i of cand) {
    if (runs[i].perBar > runs[bestIndex].perBar) bestIndex = i;
  }

  let pboResult: SweepResult['pbo'];
  if (opts.pbo && runs.length >= 2) {
    try {
      const T = Math.min(...runs.map((r) => r.rets.length));
      if (T >= 16) {
        pboResult = pboFromReturns(
          runs.map((r) => r.rets.slice(0, T)),
          { nSubsets: opts.pbo.nSubsets },
        );
      }
    } catch {
      pboResult = undefined;
    }
  }

  const cells: SweepCell[] = runs.map((r) => r.cell);
  return {
    gridKeys: Object.keys(grid),
    cells,
    combos: combos.length,
    bestIndex,
    plateau: cells[bestIndex]?.plateau,
    pbo: pboResult,
  };
}
