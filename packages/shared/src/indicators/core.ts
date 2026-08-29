/** 纯函数技术指标，前后端共用，保证图表与信号口径一致 */

export function sma(values: number[], period: number): number {
  if (period <= 0 || values.length < period) return NaN;
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / period;
}

export function ema(values: number[], period: number): number {
  if (period <= 0 || values.length === 0) return NaN;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/** 返回与输入等长的 EMA 序列，便于画均线 */
export function emaSeries(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function smaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    out.push(i + 1 < period ? NaN : sma(values.slice(0, i + 1), period));
  }
  return out;
}

/** Wilder RSI */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (values.length < slowPeriod + signalPeriod) {
    return { macd: NaN, signal: NaN, histogram: NaN };
  }
  const fastSeries = emaSeries(values, fastPeriod);
  const slowSeries = emaSeries(values, slowPeriod);
  const diffLine: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    diffLine.push(fastSeries[i] - slowSeries[i]);
  }
  // 用慢线稳定之后再算信号线，避免前段失真
  const start = slowPeriod - 1;
  const signalSeries = emaSeries(diffLine.slice(start), signalPeriod);
  const macdValue = diffLine[diffLine.length - 1];
  const signalValue = signalSeries[signalSeries.length - 1];
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

export interface BollResult {
  upper: number;
  mid: number;
  lower: number;
}

export function bollinger(values: number[], period = 20, multiplier = 2): BollResult {
  const mid = sma(values, period);
  if (Number.isNaN(mid)) return { upper: NaN, mid: NaN, lower: NaN };
  const slice = values.slice(-period);
  const variance = slice.reduce((acc, v) => acc + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + multiplier * sd, mid, lower: mid - multiplier * sd };
}

/** ATR（Wilder 平滑） */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < len; i += 1) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    prev = (prev * (period - 1) + trs[i]) / period;
  }
  return prev;
}

/**
 * 已实现波动率（%），基于收盘价对数收益的标准差
 * @param periodsPerDay 一天内的采样根数
 * @param annualize 是否年化，日频展示场景传 false
 */
export function realizedVolatility(
  closes: number[],
  periodsPerDay = 288,
  annualize = true,
): number {
  if (closes.length < 3) return NaN;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  const scale = annualize ? Math.sqrt(periodsPerDay * 365) : Math.sqrt(periodsPerDay);
  return sd * scale * 100;
}
