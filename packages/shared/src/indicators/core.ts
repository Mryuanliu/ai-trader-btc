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

// ---------------------------------------------------------------------------
// king-v4-balance Brain 原语（马丁网格 V2 专用）
//
// 逐行对照 `源流策略源码合集/king-v4-balance.mq5` 移植，每个函数注释标 EA 行号
// 锚点；EA 用 MT5 序列数组（index 0 = 最新），我们统一为**时间升序**数组，
// 下标方向已逐一换算。这些是纯数学原语，不含任何策略决策——Brain 的
// 融合/域机在 server 侧 `strategy/lib/market-regime.ts`。
// ---------------------------------------------------------------------------

/**
 * 简单均值 ATR（EA `ManualAtr` L1255–1276）：最近 period 根 TR 的算术平均。
 * 注意与上方 `atr()`（Wilder 平滑）**口径不同**——EA 的 Brain 用的是简单均值，
 * 照搬不改良（C-1：与母本行为一致优先于"更标准"）。
 */
export function atrSimple(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  const len = Math.min(highs.length, lows.length, closes.length);
  // EA 从 i=1 起有 prevClose，且需至少 period 根完整 TR
  if (period <= 0 || len < period + 1) return NaN;
  let sum = 0;
  for (let i = len - period; i < len; i += 1) {
    sum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  return sum / period;
}

export interface RegressionResult {
  /** 每根 K 线的回归斜率，已除以 atrValue（EA: slope/atr，单位 ATR/Bar） */
  slope: number;
  /** 线性拟合度 R² ∈ [0,1] */
  r2: number;
}

/**
 * 收盘价线性回归斜率 + R²（EA `RegressionSlopeAtr` L1293–1325）。
 * x=0..period-1 按时间升序；r2 = reg_num²/((nΣx²−Σx²)(nΣy²−Σy²))，与 EA 逐项同式。
 */
export function regressionSlopeAtr(
  closes: number[],
  period: number,
  atrValue: number,
): RegressionResult {
  if (period <= 2 || closes.length < period || !(atrValue > 0)) {
    return { slope: 0, r2: 0 };
  }
  const slice = closes.slice(-period);
  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  for (let i = 0; i < period; i += 1) {
    sumX += i;
    sumY += slice[i];
    sumX2 += i * i;
    sumY2 += slice[i] * slice[i];
    sumXY += i * slice[i];
  }
  const n = period;
  const regNum = n * sumXY - sumX * sumY;
  const regDen = n * sumX2 - sumX * sumX;
  const corrDen = (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY);
  const r2 = corrDen > 0 ? Math.min(1, Math.max(0, (regNum * regNum) / corrDen)) : 0;
  if (regDen === 0) return { slope: 0, r2 };
  return { slope: regNum / regDen / atrValue, r2 };
}

export interface EfficiencyResult {
  /** Kaufman 效率比 ∈ [0,1]（trendiness 用无符号值） */
  er: number;
  /** 带符号 ER = sign(净位移) × er（EA f2 用） */
  signed: number;
}

/**
 * Kaufman 效率比（EA `EfficiencyRatio` L1278–1291 + f2 符号 L1403–1404）：
 * er = |净位移| / Σ逐根位移；signed 取净位移方向。
 */
export function efficiencyRatio(closes: number[], period: number): EfficiencyResult {
  if (period <= 0 || closes.length < period + 1) return { er: 0, signed: 0 };
  let travel = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    travel += Math.abs(closes[i] - closes[i - 1]);
  }
  if (travel <= 0) return { er: 0, signed: 0 };
  const disp = closes[closes.length - 1] - closes[closes.length - 1 - period];
  const er = Math.min(1, Math.abs(disp) / travel);
  const sign = disp > 0 ? 1 : disp < 0 ? -1 : 0;
  return { er, signed: sign * er };
}

/**
 * 抖动指数（EA `ChoppinessIndex` L1327–1350）：
 * 100 × log(ΣTR / 区间高低幅) / log(period)，越高越震荡；数据不足回 50（EA 同）。
 */
export function choppinessIndex(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (period <= 1 || len < period + 2) return 50;
  let highest = -Infinity;
  let lowest = Infinity;
  let trSum = 0;
  for (let i = len - period; i < len; i += 1) {
    highest = Math.max(highest, highs[i]);
    lowest = Math.min(lowest, lows[i]);
    trSum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  const range = Math.max(1e-12, highest - lowest);
  if (trSum <= 0 || range <= 0) return 50;
  return Math.min(100, Math.max(0, (100 * Math.log(trSum / range)) / Math.log(period)));
}

/**
 * Donchian 突破强度 ∈ [-1,1]（EA `DonchianBreakoutStrength` L1352–1369）：
 * 通道取**不含当根**的前 period 根（rates[shift+1..shift+period]），
 * 上破/下破幅度按 ATR 归一后取差。与 donchian_breakout 策略的"含当根"通道刻意不同。
 */
export function donchianBreakoutStrength(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  atrValue: number,
): number {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (period <= 1 || len < period + 2 || !(atrValue > 0)) return 0;
  let prevHigh = -Infinity;
  let prevLow = Infinity;
  for (let i = len - 1 - period; i <= len - 2; i += 1) {
    prevHigh = Math.max(prevHigh, highs[i]);
    prevLow = Math.min(prevLow, lows[i]);
  }
  const close = closes[len - 1];
  const upside = Math.max(0, (close - prevHigh) / atrValue);
  const downside = Math.max(0, (prevLow - close) / atrValue);
  return Math.max(-1, Math.min(1, upside - downside));
}

export interface DiResult {
  plusDI: number;
  minusDI: number;
}

/**
 * Wilder +DI / −DI（EA iADX 缓冲 1/2，f6 L1446–1453）：
 * DM/TR 各自 Wilder RMA 平滑后 DI = 100 × RMA(DM)/RMA(TR)。数据不足回 NaN。
 */
export function adxDi(highs: number[], lows: number[], closes: number[], period = 14): DiResult {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (period <= 1 || len < 2 * period + 1) return { plusDI: NaN, minusDI: NaN };
  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < len; i += 1) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  // Wilder 平滑：首值 = 前 period 根之和，其后 prev − prev/period + x（MT5 iADX 同口径）
  let smTr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smP = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
  let smM = minusDm.slice(0, period).reduce((a, b) => a + b, 0);
  for (let i = period; i < tr.length; i += 1) {
    smTr = smTr - smTr / period + tr[i];
    smP = smP - smP / period + plusDm[i];
    smM = smM - smM / period + minusDm[i];
  }
  if (smTr <= 0) return { plusDI: 0, minusDI: 0 };
  return { plusDI: (100 * smP) / smTr, minusDI: (100 * smM) / smTr };
}
