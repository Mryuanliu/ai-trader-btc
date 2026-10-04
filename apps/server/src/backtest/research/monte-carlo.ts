import type { MonteCarloResult } from '@ai-trader/shared';
import { quantile } from './stats';

/**
 * 确定性伪随机（mulberry32）。
 *
 * Monte Carlo 必须可复现：同一份收益 + 同一个 seed → 同一组分位数，
 * 否则「这次跑过了下次跑不过」无从审计。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonteCarloOptions {
  /** 模拟次数，默认 1000 */
  n?: number;
  /** 块长（bar 数），默认 48 —— 保留序列自相关，打散噪声但留住趋势成簇的特征 */
  block?: number;
  /** 随机种子，默认 20240601（固定值以保确定性） */
  seed?: number;
}

/**
 * Moving Block Bootstrap 回撤分布（López de Prado《Advances in Financial ML》Ch.12）。
 *
 * iid bootstrap 会抹掉收益的自相关/波动聚集；固定块长整块搬移、块内顺序不变，
 * 既打断长程依赖又保留短程结构。每次重排出与原序列等长的收益 → 合成净值 → 记录最大回撤。
 *
 * 闸门判据：`maxDD_p95 < 10%`（95% 的坏运气路径下回撤仍可承受）。
 */
export function blockBootstrapMaxDD(
  rets: number[],
  opts: MonteCarloOptions = {},
): MonteCarloResult {
  const n = Math.max(1, Math.floor(opts.n ?? 1000));
  const T = rets.length;
  if (T < 4) {
    throw new Error(`收益序列仅 ${T} 根，不足以做 Monte Carlo bootstrap`);
  }
  const block = Math.max(1, Math.min(Math.floor(opts.block ?? 48), T));
  const seed = Math.floor(opts.seed ?? 20240601);
  const rnd = mulberry32(seed);
  const maxStart = Math.max(0, T - block);

  const dds: number[] = [];
  for (let s = 0; s < n; s += 1) {
    let equity = 1;
    let peak = 1;
    let dd = 0;
    let count = 0;
    while (count < T) {
      const start = Math.floor(rnd() * (maxStart + 1));
      for (let k = 0; k < block && count < T; k += 1, count += 1) {
        equity *= 1 + rets[start + k];
        if (equity > peak) peak = equity;
        if (peak > 0) dd = Math.max(dd, (peak - equity) / peak);
      }
    }
    dds.push(dd * 100);
  }

  return {
    n,
    block,
    seed,
    maxDD_p5: Number(quantile(dds, 0.05).toFixed(4)),
    maxDD_p50: Number(quantile(dds, 0.5).toFixed(4)),
    maxDD_p95: Number(quantile(dds, 0.95).toFixed(4)),
  };
}
