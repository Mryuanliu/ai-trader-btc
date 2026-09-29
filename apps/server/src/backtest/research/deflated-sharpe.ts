import type { DeflatedSharpeResult } from '@ai-trader/shared';
import { kurtosis, normInv, normalCdf, sharpePerBar, skewness, std } from './stats';

const EULER_GAMMA = 0.5772156649015329;

/**
 * N 次独立试验下「最大夏普」的期望（Bailey & López de Prado 2014 近似式）。
 * 试验越多，靠运气挑出的最优夏普越大 —— DSR 用它把这份「挑选偏差」扣掉。
 */
export function expectedMaxSharpe(trialSharpes: number[]): number {
  const n = trialSharpes.length;
  if (n < 2) return 0;
  const v = std(trialSharpes);
  const z1 = normInv(1 - 1 / n);
  const z2 = normInv(1 - 1 / (n * Math.E));
  return v * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2);
}

/**
 * Deflated Sharpe Ratio：返回「真实夏普 > 期望最大夏普」的概率（0~1）。
 *
 * DSR = Φ[ (SR_obs − SR*) · √(T−1) / √(1 − γ1·SR_obs + (γ2−1)/4·SR_obs²) ]
 * 其中 obsSharpe / expectedMax / skew / kurt / T 均为「每根 bar」口径。passed 当 DSR ≥ threshold。
 *
 * 注意：DSR 是概率，恒 ≥0；「判过拟合」= DSR 低于阈值（默认 0.95），
 * 即观测夏普无法在扣除多次试验的挑选偏差后稳健胜出。
 */
export function deflatedSharpe(params: {
  /** 待检验的每-bar 夏普 */
  obsSharpe: number;
  /** 参与挑选的各试验的每-bar 夏普集合（walk-forward 各窗 / sweep 各组合） */
  trialSharpes: number[];
  /** 观测收益序列（算偏度/峰度/样本数 T） */
  obsReturns: number[];
  threshold?: number;
}): DeflatedSharpeResult {
  const { obsSharpe, trialSharpes, obsReturns } = params;
  const threshold = params.threshold ?? 0.95;
  const T = obsReturns.length;
  const skew = skewness(obsReturns);
  const kurt = kurtosis(obsReturns);
  const expMax = expectedMaxSharpe(trialSharpes);

  const denomVar = 1 - skew * obsSharpe + ((kurt - 1) / 4) * obsSharpe ** 2;
  const denom = denomVar > 0 ? Math.sqrt(denomVar) : 1;
  const z = T > 1 ? ((obsSharpe - expMax) * Math.sqrt(T - 1)) / denom : 0;
  const dsr = normalCdf(z);

  return {
    obsSharpe: Number(obsSharpe.toFixed(6)),
    expectedMaxSharpe: Number(expMax.toFixed(6)),
    dsr: Number(dsr.toFixed(6)),
    nTrials: trialSharpes.length,
    T,
    skew: Number(skew.toFixed(6)),
    kurtosis: Number(kurt.toFixed(6)),
    passed: dsr >= threshold,
  };
}

/** 便捷入口：直接从观测收益序列 + 试验夏普集合算 DSR */
export function deflatedSharpeFromReturns(
  obsReturns: number[],
  trialSharpes: number[],
  threshold = 0.95,
): DeflatedSharpeResult {
  return deflatedSharpe({
    obsSharpe: sharpePerBar(obsReturns),
    trialSharpes,
    obsReturns,
    threshold,
  });
}
