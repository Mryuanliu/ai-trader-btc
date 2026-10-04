import {
  TIMEFRAME_MS,
  type BacktestConfig,
  type Candle,
  type PboResult,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';
import { mean, perBarReturns, sharpePerBar, std } from './stats';

/**
 * PBO（Probability of Backtest Overfitting）——Bailey & López de Prado (2014)
 * 「The Probability of Backtest Overfitting」的 CSCV（Combinatorially Symmetric
 * Cross-Validation）判定流程，逐字对齐论文：
 *
 * 1. 有性能矩阵 M：N 行 = N 个候选配置，S 列 = S 个等长不相交时间子集。
 * 2. 枚举从 S 个子集里取 ⌈S/2⌉ 个当「样本内」的全部组合 ω；其补集当「样本外」。
 * 3. 对每个 ω：样本内按性能挑「最优」配置 n*；算 n* 在样本外的**相对排名** w
 *    （1=最好、0=最差、0.5=中位）；λ = ln( w / (1 − w) )。
 * 4. PBO = ratio / (1 + ratio)，ratio = {λ<0} 的占比（论文的相对频率平滑）。
 *
 * λ<0 ⇔ w<0.5 ⇔「样本内冠军在样本外跌破中位」，即那次「挑最优」是过拟合。
 * `cscvPbo` 是纯数学（同矩阵同 S → 同 PBO，可单测）；`computePbo` 负责跑回测造矩阵。
 */

const MAX_CSCV_COMBOS = 1000;
const DEFAULT_SUBSETS = 16;

/** 从 [0,n) 取 k 的所有组合 */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

/** 某值在群体中的相对排名 [0,1]（越大越好；并列取平均秩） */
function relativeRank(value: number, population: number[]): number {
  const n = population.length;
  if (n <= 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const p of population) {
    if (p < value) below += 1;
    else if (p === value) equal += 1;
  }
  return (below + (equal - 1) / 2) / (n - 1);
}

function meanAcross(row: number[], idx: number[]): number {
  if (idx.length === 0) return 0;
  let s = 0;
  for (const j of idx) s += row[j];
  return s / idx.length;
}

export interface CscvOptions {
  /** 对称子集数 S（若矩阵列数更多会等距合并），默认取矩阵列数（≤ 16） */
  nSubsets?: number;
}

/**
 * 纯 CSCV：输入「配置 × 时间子集」性能矩阵 → PBO。
 *
 * @param perfMatrix [N 配置][S 子集] 性能值（这里用各配置在各子集上的 per-bar 夏普）
 */
export function cscvPbo(perfMatrix: number[][], opts: CscvOptions = {}): PboResult {
  const N = perfMatrix.length;
  if (N < 2) throw new Error('PBO 需至少 2 个候选配置（单一配置无从谈「挑选偏差」）');
  const C0 = perfMatrix[0]?.length ?? 0;
  if (C0 < 4) throw new Error(`PBO 需至少 4 个时间子集（当前 ${C0}）`);
  for (const row of perfMatrix) {
    if (row.length !== C0) throw new Error('PBO 性能矩阵每行的子集数必须一致');
  }

  const S = Math.min(Math.max(4, Math.floor(opts.nSubsets ?? C0)), C0);
  const matrix: number[][] =
    S === C0
      ? perfMatrix
      : perfMatrix.map((row) => {
          const out: number[] = [];
          for (let j = 0; j < S; j += 1) {
            const lo = Math.floor((j * C0) / S);
            const hi = Math.floor(((j + 1) * C0) / S);
            out.push(mean(row.slice(lo, Math.max(hi, lo + 1))));
          }
          return out;
        });

  const half = Math.ceil(S / 2);
  let combos = combinations(S, half);
  if (combos.length > MAX_CSCV_COMBOS) {
    const step = Math.ceil(combos.length / MAX_CSCV_COMBOS);
    combos = combos.filter((_, i) => i % step === 0);
  }

  const lambdas: number[] = [];
  for (const is of combos) {
    const isSet = new Set(is);
    const oos = Array.from({ length: S }, (_, j) => j).filter((j) => !isSet.has(j));
    if (oos.length === 0) continue;
    const isPerf: number[] = [];
    const oosPerf: number[] = [];
    for (const row of matrix) {
      isPerf.push(meanAcross(row, is));
      oosPerf.push(meanAcross(row, oos));
    }
    let best = 0;
    for (let i = 1; i < N; i += 1) if (isPerf[i] > isPerf[best]) best = i;
    const w = relativeRank(oosPerf[best], oosPerf);
    const eps = 1e-12;
    const wc = Math.min(1 - eps, Math.max(eps, w));
    lambdas.push(Math.log(wc / (1 - wc)));
  }

  if (lambdas.length === 0) throw new Error('CSCV 未产生任何有效组合');
  const ratio = lambdas.filter((l) => l < 0).length / lambdas.length;
  const pbo = ratio > 0 ? ratio / (1 + ratio) : 0;

  return {
    pbo: Number(pbo.toFixed(6)),
    nCombos: combos.length,
    lambdas: lambdas.map((l) => Number(l.toFixed(6))),
    nConfigs: N,
    nSubsets: S,
    subsetBars: 0,
  };
}

/**
 * 纯函数：由「配置 × 逐根收益」构造性能矩阵（每配置切 S 段、段内 per-bar 夏普）再跑 CSCV。
 *
 * 与 `computePbo` 的区分：这里收益矩阵由调用方备好（可单测），`computePbo` 负责跑回测取收益。
 * @param returnsMatrix [N 配置][T bar] 同一时间轴上的逐根收益
 */
export function pboFromReturns(
  returnsMatrix: number[][],
  opts: { nSubsets?: number } = {},
): PboResult {
  const T = returnsMatrix[0]?.length ?? 0;
  if (T === 0) throw new Error('PBO 收益矩阵为空');
  const S = Math.max(4, Math.floor(opts.nSubsets ?? DEFAULT_SUBSETS));
  const perfMatrix = returnsMatrix.map((row) => {
    const out: number[] = [];
    for (let j = 0; j < S; j += 1) {
      const lo = Math.floor((j * row.length) / S);
      const hi = Math.floor(((j + 1) * row.length) / S);
      out.push(sharpePerBar(row.slice(lo, Math.max(hi, lo + 1))));
    }
    return out;
  });
  const res = cscvPbo(perfMatrix, { nSubsets: S });
  res.subsetBars = Math.floor(T / S);
  return res;
}

/**
 * 端到端 PBO：对一组候选配置在同一时间轴上各跑一次回测，取决策区逐根收益切成
 * S 段（段内 per-bar 夏普当性能），再跑 CSCV。
 *
 * @param configs 参与「挑选」的比较配置（≥2；通常冠军邻域若干组）
 */
export async function computePbo(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  configs: Record<string, unknown>[],
  opts: { nSubsets?: number } = {},
): Promise<PboResult> {
  if (configs.length < 2) throw new Error('PBO 需至少 2 个配置');
  const warmup = base.warmupBars;
  const S = Math.max(4, Math.floor(opts.nSubsets ?? DEFAULT_SUBSETS));
  const returnsMatrix: number[][] = [];
  for (const params of configs) {
    const res = await runBacktestOnCandles(
      createStrategy(strategyName),
      { ...base, params: { ...(base.params ?? {}), ...params } },
      candles,
    );
    const rets = perBarReturns(res.report.equityCurve.slice(warmup).map((p) => p.equity));
    returnsMatrix.push(rets);
  }
  const T = Math.min(...returnsMatrix.map((r) => r.length));
  if (T < S * 4) throw new Error(`决策区仅 ${T} 根，不足以切 ${S} 段做 PBO`);
  // 对齐到公共长度（各配置理论上等长，防御性截断）后交给纯函数
  return pboFromReturns(
    returnsMatrix.map((r) => r.slice(0, T)),
    { nSubsets: S },
  );
}

/** 退化检测：所有配置所有子集性能方差为 0 → PBO 无意义（供上层自检） */
export function isDegeneratePerfMatrix(rows: number[][]): boolean {
  return !(rows.reduce((acc, r) => acc + std(r), 0) > 0);
}

export function barsPerYearFor(interval: keyof typeof TIMEFRAME_MS): number {
  return (365 * 86_400_000) / TIMEFRAME_MS[interval];
}
