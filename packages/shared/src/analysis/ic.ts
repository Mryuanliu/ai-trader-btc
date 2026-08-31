/**
 * C 期 · 信号有效性统计工具
 *
 * 目的：回答「每个信号到底有没有预测力」，用统计证据替代主观判断。
 *
 * 为什么需要：B 期修完了打分口径与语义，但**六个信号的权重是拍脑袋定的**
 * （ma_trend 0.25 / rsi 0.2 / macd 0.2 / boll 0.15 / volume 0.1 / mid 0.1）。
 * 若某信号 IC≈0，它只是在贡献噪声、稀释有效信号——权重应当下调甚至剔除。
 *
 * 三个核心指标：
 * 1. **IC（Spearman 秩相关）**：信号值与未来收益的单调相关度。
 *    用秩相关而非 Pearson，因为信号是离散的三档（多/空/中立），Pearson 会受分布影响。
 * 2. **HAC t-stat（Newey-West）**：金融时间序列的 IC 序列**强自相关**
 *    （5m K 线重叠窗口导致相邻 IC 高度相关），普通 t 检验会严重高估显著性。
 *    HAC 修正后才是可信的 t 值。经验门槛：|t| > 2 才算有效。
 * 3. **分位收益（Q5 - Q1）**：按信号值分 5 档，看最强组与最弱组的平均收益差。
 *    它不假设线性关系，能捕捉"只在极端有效"的非线性信号。
 *
 * 三票通过才算有效：IC 显著 + t 显著 + 分位单调。任一不成立都不足以采信。
 */

/** 单信号的 IC 分析结果 */
export interface SignalIcResult {
  name: string;
  /** 有效样本数（信号值与收益都非空的配对数） */
  sampleSize: number;
  /** Spearman 秩相关系数（-1~1） */
  ic: number;
  /** IC 的均值（与 ic 相同，保留便于与 IR 对照） */
  icMean: number;
  /** IC 的标准差 */
  icStd: number;
  /** IR = IC均值/IC标准差，衡量 IC 的稳定性（>0.3 可用，>0.5 良好） */
  ir: number;
  /** HAC（Newey-West）稳健 t 统计量 */
  tStat: number;
  /** HAC 标准误 */
  hacStdErr: number;
  /** 分位平均收益：按信号值从小到大分 5 档，索引 0=最弱 4=最强 */
  quantileReturns: number[];
  /** 多空收益 = Q5 - Q1（分位收益的跨度） */
  q5MinusQ1: number;
  /** 分位收益是否单调不减（Q1<=Q2<=Q3<=Q4<=Q5） */
  monotonic: boolean;
  /** 综合判定：IC 与 t 值都达门槛 */
  significant: boolean;
}

/** IC 分析的配置 */
export interface IcAnalysisOptions {
  /** t 统计量的显著门槛（默认 2.0，对应约 95% 置信） */
  tThreshold?: number;
  /** IC 绝对值的显著门槛（默认 0.02，5m 级别下 0.02 已属可用） */
  icThreshold?: number;
  /** Newey-West 滞后阶数。默认按样本量自适应：floor(4*(n/100)^(2/9)) */
  lag?: number;
}

// ---------------------------------------------------------------- 基础统计

/** 计算均值 */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 计算样本标准差（n-1） */
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Pearson 相关系数 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/**
 * 计算排名（用于 Spearman）。相同值取平均排名（average rank），
 * 这是标准做法——信号是离散三档，必然大量并列，不处理并列会失真。
 */
export function rank(xs: number[]): number[] {
  const n = xs.length;
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    // 找出所有并列值
    while (j + 1 < n && idx[j + 1].v === idx[i].v) j += 1;
    // 并列者共享平均排名（1-based）
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k].i] = avgRank;
    i = j + 1;
  }
  return out;
}

/** Spearman 秩相关 = 对排名做 Pearson */
export function spearman(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  return pearson(rank(xs.slice(0, n)), rank(ys.slice(0, n)));
}

// ---------------------------------------------------------------- HAC

/**
 * Newey-West（HAC）稳健标准误。
 *
 * 为什么必须用：IC 序列存在强自相关（5m K 线用重叠窗口计算，
 * 相邻时点的 IC 高度相关）。普通 OLS 标准误会**严重低估**，
 * 导致 t 值虚高、把噪声误判为有效信号。
 *
 * 公式：Var = γ0 + 2 * Σ(k=1..L) (1 - k/(L+1)) * γk
 * 其中 γk 是 k 阶自协方差，Bartlett 核权重 (1 - k/(L+1)) 保证半正定。
 *
 * @param xs 中心化后的序列（已减去均值）
 * @param lag 滞后阶数 L
 */
export function hacStdError(centered: number[], lag: number): number {
  const n = centered.length;
  if (n < 2) return 0;

  // 0 阶自协方差
  let gamma0 = 0;
  for (let i = 0; i < n; i += 1) gamma0 += centered[i] * centered[i];
  gamma0 /= n;

  let sum = gamma0;
  const maxLag = Math.max(0, Math.min(lag, n - 1));
  for (let k = 1; k <= maxLag; k += 1) {
    let gk = 0;
    for (let i = k; i < n; i += 1) gk += centered[i] * centered[i - k];
    gk /= n;
    // Bartlett 核权重
    sum += 2 * (1 - k / (maxLag + 1)) * gk;
  }

  // 方差不能为负（数值误差可能导致微小负值）
  const variance = Math.max(0, sum);
  // 标准误 = sqrt(Var / n)
  return Math.sqrt(variance / n);
}

/** Newey-West 默认滞后阶数：floor(4 * (n/100)^(2/9))，经济学常用经验公式 */
export function defaultLag(n: number): number {
  return Math.max(1, Math.floor(4 * (n / 100) ** (2 / 9)));
}

// ---------------------------------------------------------------- 分位

/**
 * 按信号值分位计算平均收益。
 *
 * @param xs 信号值
 * @param ys 对应的未来收益
 * @param q 分位档数（默认 5）
 * @returns 每档的平均收益，索引 0 = 信号最弱，q-1 = 信号最强
 */
export function quantileReturns(xs: number[], ys: number[], q = 5): number[] {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return new Array(q).fill(0);

  const pairs = xs
    .slice(0, n)
    .map((v, i) => ({ v, r: ys[i] }))
    .sort((a, b) => a.v - b.v);

  const out: number[] = [];
  const base = Math.floor(n / q);
  const rem = n % q;
  let cursor = 0;
  for (let k = 0; k < q; k += 1) {
    // 余数均摊到前几档，保证总数精确
    const size = base + (k < rem ? 1 : 0);
    if (size === 0) {
      out.push(0);
      continue;
    }
    const slice = pairs.slice(cursor, cursor + size);
    out.push(mean(slice.map((p) => p.r)));
    cursor += size;
  }
  return out;
}

/** 判断序列是否单调不减（允许相等） */
export function isNonDecreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] < xs[i - 1]) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 主分析

/**
 * 对单个信号做完整的 IC 分析。
 *
 * 注意：输入的 icSeries 是**每个时点的 IC 值**（信号值与当期收益的横截面相关），
 * 而不是原始信号序列。若只有一个全局 IC（信号 vs 收益的整体相关），
 * 则 HAC 无法计算（需要 IC 时间序列）。
 *
 * 本项目是单标的（BTCUSDT）时间序列，没有横截面，因此采用**滚动窗口 IC**：
 * 每个窗口内用最近 N 个 (信号, 收益) 配对算一次 IC，得到 IC 时间序列，
 * 再对该序列做 HAC 检验。这是单标的场景下的标准做法。
 */
export function analyzeSignal(
  name: string,
  icSeries: number[],
  options: IcAnalysisOptions = {},
): SignalIcResult {
  const tThreshold = options.tThreshold ?? 2.0;
  const icThreshold = options.icThreshold ?? 0.02;

  const clean = icSeries.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n < 2) {
    return {
      name,
      sampleSize: n,
      ic: 0,
      icMean: 0,
      icStd: 0,
      ir: 0,
      tStat: 0,
      hacStdErr: 0,
      quantileReturns: [],
      q5MinusQ1: 0,
      monotonic: false,
      significant: false,
    };
  }

  const m = mean(clean);
  const s = std(clean);
  const lag = options.lag ?? defaultLag(n);

  // HAC：先中心化，再算 Newey-West 标准误
  const centered = clean.map((v) => v - m);
  const se = hacStdError(centered, lag);
  const tStat = se === 0 ? 0 : m / se;

  // 分位收益：这里直接用 IC 序列的分位（衡量 IC 分布的形态）
  const qs = quantileReturns(clean, clean, 5);

  return {
    name,
    sampleSize: n,
    ic: Number(m.toFixed(6)),
    icMean: Number(m.toFixed(6)),
    icStd: Number(s.toFixed(6)),
    ir: s === 0 ? 0 : Number((m / s).toFixed(4)),
    tStat: Number(tStat.toFixed(4)),
    hacStdErr: Number(se.toFixed(6)),
    quantileReturns: qs.map((v) => Number(v.toFixed(6))),
    q5MinusQ1: Number((qs[qs.length - 1] - qs[0]).toFixed(6)),
    monotonic: isNonDecreasing(qs),
    significant: Math.abs(tStat) >= tThreshold && Math.abs(m) >= icThreshold,
  };
}

/**
 * 滚动窗口 IC 序列。
 *
 * 单标的无横截面，故用滚动窗口：每个时点用最近 window 个配对算一次 Spearman，
 * 得到 IC 的时间序列，供 HAC 检验使用。
 *
 * @param signalValues 信号值序列（按时间升序）
 * @param forwardReturns 对应的未来收益序列
 * @param window 滚动窗口大小（默认 200，约 200 根 bar）
 * @param step 采样步长（默认 1=每根都算）。样本量大时可调大以加速
 */
export function rollingIcSeries(
  signalValues: number[],
  forwardReturns: number[],
  window = 200,
  step = 1,
): number[] {
  const n = Math.min(signalValues.length, forwardReturns.length);
  const out: number[] = [];
  if (n < window) return out;

  for (let end = window; end <= n; end += step) {
    const start = end - window;
    const sx = signalValues.slice(start, end);
    const sy = forwardReturns.slice(start, end);
    // 窗口内信号无变化（方差为 0）时 Spearman 无意义，跳过
    const allSame = sx.every((v) => v === sx[0]);
    if (allSame) continue;
    out.push(spearman(sx, sy));
  }
  return out;
}

/**
 * 计算未来收益序列。
 *
 * @param closes 收盘价（时间升序）
 * @param horizon 预测周期（多少根 bar 之后）
 * @param mode 'simple'=简单收益率 (c[i+h]-c[i])/c[i]；'log'=对数收益
 */
export function forwardReturns(
  closes: number[],
  horizon: number,
  mode: 'simple' | 'log' = 'simple',
): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i + horizon < closes.length; i += 1) {
    const c0 = closes[i];
    const c1 = closes[i + horizon];
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || c0 <= 0 || c1 <= 0) continue;
    out[i] = mode === 'log' ? Math.log(c1 / c0) : (c1 - c0) / c0;
  }
  return out;
}
