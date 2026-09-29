/**
 * 回测研究用统计工具（纯函数）。
 *
 * 供 walk-forward / CPCV / Deflated Sharpe / sweep 共用。
 * 关键约定：**DSR 的一切输入（obsSharpe/skew/kurt/T）都用「每根 bar 的收益」口径**，
 * 不年化——López de Prado 的原式在 per-period 单位下才成立；年化只用于展示。
 */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差（无偏，n-1）；样本 <2 返回 0 */
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** 样本偏度（third standardized moment，有偏估计即可满足 DSR 用途） */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  let s2 = 0;
  let s3 = 0;
  for (const x of xs) {
    const d = x - m;
    s2 += d * d;
    s3 += d * d * d;
  }
  if (s2 === 0) return 0;
  const denom = Math.sqrt(s2 / n);
  return (s3 / n) / (denom ** 3);
}

/** 峰度（**非超额**，正态≈3） */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs);
  let s2 = 0;
  let s4 = 0;
  for (const x of xs) {
    const d = x - m;
    s2 += d * d;
    s4 += d * d * d * d;
  }
  if (s2 === 0) return 3;
  return s4 / n / (s2 / n) ** 2;
}

/** 每根 bar 收益的夏普（mean/std，不年化）——DSR 用它 */
export function sharpePerBar(rets: number[]): number {
  const s = std(rets);
  if (!(s > 0)) return 0;
  return mean(rets) / s;
}

/** 年化夏普：per-bar 夏普 × √(每年 bar 数) */
export function annualizeSharpe(perBar: number, barsPerYear: number): number {
  return perBar * Math.sqrt(Math.max(1, barsPerYear));
}

/** 净值曲线 → 逐根收益率（ equity[i]/equity[i-1] - 1 ） */
export function perBarReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1];
    if (prev > 0) out.push(equity[i] / prev - 1);
  }
  return out;
}

/** 由初始本金与逐根收益拼净值路径（用于拼接多段 OOS） */
export function equityPath(initial: number, rets: number[]): number[] {
  const out: number[] = [initial];
  let e = initial;
  for (const r of rets) {
    e *= 1 + r;
    out.push(e);
  }
  return out;
}

/** 净值路径的最大回撤百分比 */
export function maxDrawdownPct(path: number[]): number {
  let peak = path.length > 0 ? path[0] : 0;
  let dd = 0;
  for (const e of path) {
    if (e > peak) peak = e;
    if (peak > 0) dd = Math.max(dd, (peak - e) / peak);
  }
  return dd * 100;
}

/** 标准正态 CDF（Abramowitz-Stegun 近似，误差 ~7.5e-8） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989380426532331 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** 标准正态分位数（在 normalCdf 上二分求逆，稳健且精度 ~1e-7） */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 分位数（线性插值） */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}
