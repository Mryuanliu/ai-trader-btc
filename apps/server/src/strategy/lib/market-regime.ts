// ---------------------------------------------------------------------------
// MarketRegime：king-v4-balance「Brain」市场内核的移植（方案 M1 / W2）
//
// 逐行对照 `king-v4-balance.mq5`：
// - 六因子单框架评分 ComputeFrameScore（L1377–1459）
// - 七态域机 MarketStateFromScore（L1461–1471）
// - 三框架融合 + 冲突阻尼 + 自适应平滑 UpdateMarketRegimeState（L1694–1759）
// - 粘滞方向域机 g_ts_dir（L1761–1786）
//
// parity 声明（C-1）：
// - EA 每 5 秒重算；我们每根执行周期 K 线调一次 update()——评分全部是
//   **已完成 K 线的纯函数**，只有刷新频率差（方案 §4 粒度差声明）。
// - EA 直接 CopyRates 取 M1/M5/M15；我们用 1x K 线按 {1,5,15} 聚合重采样，
//   与交易所原始高周期线在对齐边界上可能相差 ±1 根（已如实记录）。
// - 归一常数 slope 0.06 / macd 0.30 / di 40 是黄金 M1 标定值（L1398/1440/1453），
//   做成 cfg.calib 对象参数；BTC 按等价分位重校准后才开 useBrain（E1 前置项）。
// ---------------------------------------------------------------------------
import {
  atrSimple,
  regressionSlopeAtr,
  efficiencyRatio,
  choppinessIndex,
  donchianBreakoutStrength,
  adxDi,
  emaSeries,
  macd,
} from '@ai-trader/shared';
import type { Candle } from '@ai-trader/shared';

export interface RegimeCalib {
  /** f1 斜率归一（EA 0.06 ATR/Bar，L1398） */
  slopeNorm: number;
  /** f4 MACD 柱归一（EA 0.30 × ATR，L1440） */
  macdNorm: number;
  /** f6 DI 差归一（EA 40，L1453） */
  diNorm: number;
}

export interface RegimeConfig {
  /** 三框架倍率（EA M1/M5/M15 = 运行时周期的 {1,5,15}，L247） */
  tfMults: number[];
  /** 融合权重（EA L1700 {0.30,0.36,0.34}；注意非 L248 的旧数组——以运行时生效的 L1700 为准） */
  frameWeights: number[];
  trendRange: number;   // EA GOLDKING_MARKET_RANGE_LIMIT = 20
  trendConfirm: number; // 45
  trendStrong: number;  // 70
  trendDirEnter: number; // 26（L70）
  trendDirExit: number;  // 14（L71）
  chopGate: number;      // 0.58（L72）
  calib: RegimeCalib;
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  tfMults: [1, 5, 15],
  frameWeights: [0.30, 0.36, 0.34],
  trendRange: 20,
  trendConfirm: 45,
  trendStrong: 70,
  trendDirEnter: 26,
  trendDirExit: 14,
  chopGate: 0.58,
  calib: { slopeNorm: 0.06, macdNorm: 0.30, diNorm: 40 },
};

/** 六因子明细（EA f1–f6，M8 前端 hover 展示用；均为 [-1,1] 归一分量） */
export interface FrameFactors {
  /** f1 回归斜率×拟合度（w=0.34） */
  slope: number;
  /** f2 带符号效率比（w=0.20） */
  er: number;
  /** f3 EMA 结构+斜率（w=0.18） */
  ema: number;
  /** f4 MACD 柱动量（w=0.12） */
  macd: number;
  /** f5 Donchian 突破强度（w=0.10） */
  donchian: number;
  /** f6 ADX 方向平衡（w=0.06） */
  di: number;
}

const ZERO_FACTORS: FrameFactors = { slope: 0, er: 0, ema: 0, macd: 0, donchian: 0, di: 0 };

export interface FrameResult {
  /** 单框架评分 [-100,100]（EA L1458） */
  score: number;
  /** 趋势度 [0,1]（EA L1457：0.40ER+0.30R²+0.30|slope|/norm） */
  trendiness: number;
  /** 六因子分量（纯展示，不参与合成——合成用的就是这些 f1..f6） */
  factors: FrameFactors;
}

const clampD = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampUnit = (v: number): number => clampD(v, -1, 1);

/**
 * 1x K 线聚合成 Nx 框架（时间升序；尾部对齐分组，头部不足一组丢弃）。
 * OHLC：o=组首开、h=max、l=min、c=组尾收。
 */
export function resample(candles: Candle[], n: number): Candle[] {
  if (n <= 1) return candles;
  const out: Candle[] = [];
  const rem = candles.length % n; // 头部余数丢弃，保证末组吃到最新一根
  for (let s = rem; s + n <= candles.length; s += n) {
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    for (let i = s; i < s + n; i += 1) {
      high = Math.max(high, candles[i].high);
      low = Math.min(low, candles[i].low);
      vol += candles[i].volume;
    }
    out.push({
      time: candles[s].time,
      open: candles[s].open,
      high,
      low,
      close: candles[s + n - 1].close,
      volume: vol,
    });
  }
  return out;
}

/**
 * 单框架六因子评分（EA ComputeFrameScore L1377–1459 逐项照搬）。
 * per-tf 周期与 EA 一致：slope 20/18/14、ER 30/24/20、prev_shift 3/2/2、Donchian 24/20/20。
 * 数据不足（<70 根框架 K 线，同 EA L1387）→ 该框架 0 分（EA 同样带 0 进融合）。
 */
export function computeFrameScore(frame: Candle[], tfIndex: number, cfg: RegimeConfig): FrameResult {
  if (frame.length < 70) return { score: 0, trendiness: 0, factors: ZERO_FACTORS };
  const highs = frame.map((c) => c.high);
  const lows = frame.map((c) => c.low);
  const closes = frame.map((c) => c.close);
  const atrValue = atrSimple(highs, lows, closes, 14);
  if (!(atrValue > 0)) return { score: 0, trendiness: 0, factors: ZERO_FACTORS };

  const calib = cfg.calib;

  // F1 回归斜率 × 拟合度阻尼（L1394–1398）
  const slopePeriod = tfIndex === 0 ? 20 : tfIndex === 1 ? 18 : 14;
  const reg = regressionSlopeAtr(closes, slopePeriod, atrValue);
  const f1 = clampUnit(reg.slope / calib.slopeNorm) * (0.5 + 0.5 * reg.r2);

  // F2 带符号效率比（L1400–1404）
  const erPeriod = tfIndex === 0 ? 30 : tfIndex === 1 ? 24 : 20;
  const er = efficiencyRatio(closes, erPeriod);
  const f2 = er.signed;

  // F3 EMA8/21/55 结构：stack + 斜率（L1406–1431）
  const prevShift = tfIndex === 0 ? 3 : 2;
  const fast = emaSeries(closes, 8);
  const mid = emaSeries(closes, 21);
  const slow = emaSeries(closes, 55);
  let f3 = 0;
  if (closes.length > prevShift) {
    const f = fast[fast.length - 1];
    const m = mid[mid.length - 1];
    const s = slow[slow.length - 1];
    const fp = fast[fast.length - 1 - prevShift];
    const mp = mid[mid.length - 1 - prevShift];
    const sp = slow[slow.length - 1 - prevShift];
    let stack: number;
    if (f > m && m > s) stack = 1;
    else if (f < m && m < s) stack = -1;
    else stack = clampUnit((f - s) / atrValue);
    const emaSlope = clampUnit(
      ((f - fp) / atrValue) * 0.5 + ((m - mp) / atrValue) * 0.35 + ((s - sp) / atrValue) * 0.15,
    );
    f3 = 0.55 * stack + 0.45 * emaSlope;
  }

  // F4 MACD 柱动量（L1433–1440；柱=(main−signal)/ATR/0.30）
  const hist = macd(closes).histogram;
  const f4 = Number.isFinite(hist) ? clampUnit(hist / atrValue / calib.macdNorm) : 0;

  // F5 Donchian 突破强度（L1442–1444；通道不含当根）
  const donPeriod = tfIndex === 0 ? 24 : 20;
  const f5 = donchianBreakoutStrength(highs, lows, closes, donPeriod, atrValue);

  // F6 ADX 方向平衡（L1446–1453）
  const di = adxDi(highs, lows, closes, 14);
  const f6 = Number.isFinite(di.plusDI) && Number.isFinite(di.minusDI)
    ? clampUnit((di.plusDI - di.minusDI) / calib.diNorm)
    : 0;

  // 合成（L1455–1458）：score = 方向 × 趋势度
  const dir = clampUnit(
    0.34 * f1 + 0.2 * f2 + 0.18 * f3 + 0.12 * f4 + 0.1 * f5 + 0.06 * f6,
  );
  const slopeMag = clampD(Math.abs(reg.slope) / calib.slopeNorm, 0, 1);
  const trendiness = clampD(0.4 * er.er + 0.3 * reg.r2 + 0.3 * slopeMag, 0, 1);
  return {
    score: clampD(100 * dir * trendiness, -100, 100),
    trendiness,
    factors: { slope: f1, er: f2, ema: f3, macd: f4, donchian: f5, di: f6 },
  };
}

/** 七态（EA MarketStateFromScore L1461–1471 + MarketStateText L1473–1488） */
export function marketStateFromScore(score: number, cfg: RegimeConfig): number {
  const abs = Math.abs(score);
  if (abs <= cfg.trendRange) return 0;
  if (abs < cfg.trendConfirm) return score > 0 ? 1 : -1;
  if (abs < cfg.trendStrong) return score > 0 ? 2 : -2;
  return score > 0 ? 3 : -3;
}

const STATE_TEXT: Record<number, string> = {
  3: '强多',
  2: '多头确认',
  1: '弱多',
  0: '震荡',
  [-1]: '弱空',
  [-2]: '空头确认',
  [-3]: '强空',
};

export interface RegimeSnapshot {
  /** 平滑后主评分（EA g_market_score） */
  score: number;
  /** 未经冲突阻尼/平滑的加权原始分（EA g_market_score_raw） */
  scoreRaw: number;
  /** 阻尼后的目标分（EA g_market_score_target） */
  scoreTarget: number;
  /** 七态 -3..3 */
  state: number;
  stateText: string;
  /** 粘滞方向域机输出：-1/0/+1（EA g_ts_dir；0=双向网格，±1=只做顺势） */
  dir: number;
  /** 抖动度 [0,1]（EA g_ts_chop，L1766–1769：0.55(1−ER30)+0.45·Chop20/100） */
  chop: number;
  /** 三框架同向权重占比（EA g_market_score_coherence） */
  coherence: number;
  /** 三框架冲突权重占比（EA g_market_conflict_weight；≥0.40 → 阻尼 ×0.72） */
  conflict: number;
  /** 加权趋势度 [0,1]（EA weighted_trend/weight_sum，供篮子目标 amp 用） */
  strength: number;
  frames: Array<{ mult: number; score: number; trendiness: number; factors: FrameFactors }>;
}

/**
 * Brain 状态机：策略持实例（每实例独立），回测/实盘同一代码路径。
 * 每根执行周期 K 线调 update(1x 升序 K 线数组)。
 */
export class MarketRegime {
  readonly cfg: RegimeConfig;
  private score = 0;
  private dir = 0;
  private chop = 0;
  private last: RegimeSnapshot | null = null;
  private initialized = false;

  constructor(cfg: RegimeConfig = DEFAULT_REGIME_CONFIG) {
    this.cfg = cfg;
  }

  /** force=true（EA onStart 首次）跳过平滑直接吸附目标 */
  reset(force = false): void {
    this.dir = 0;
    this.chop = 0;
    if (!force) this.score = 0;
    this.initialized = false;
  }

  update(candles: Candle[], force = false): RegimeSnapshot {
    const cfg = this.cfg;
    const weightSum = cfg.frameWeights.reduce((a, b) => a + b, 0);

    // ---- 三框架评分（L1700–1718）----
    const frames = cfg.tfMults.map((mult, i) => {
      const r = computeFrameScore(resample(candles, mult), i, cfg);
      return { mult, ...r };
    });
    let weightedScore = 0;
    let weightedTrend = 0;
    frames.forEach((fr, i) => {
      weightedScore += fr.score * cfg.frameWeights[i];
      weightedTrend += fr.trendiness * cfg.frameWeights[i];
    });

    // ---- 融合 + 冲突阻尼（L1720–1742）----
    const baseScore = clampD(weightedScore / weightSum, -100, 100);
    const baseDir = baseScore > 0 ? 1 : baseScore < 0 ? -1 : 0;
    let aligned = 0;
    let conflictW = 0;
    frames.forEach((fr, i) => {
      const fd = fr.score > 0 ? 1 : fr.score < 0 ? -1 : 0;
      if (fd === 0 || Math.abs(fr.score) < 15) return; // 噪声框架不参与投票（L1728）
      if (fd === baseDir) aligned += cfg.frameWeights[i];
      else conflictW += cfg.frameWeights[i];
    });
    const coherence = clampD(aligned / weightSum, 0, 1);
    const conflict = conflictW / weightSum;
    const targetScore = clampD(conflict >= 0.4 ? baseScore * 0.72 : baseScore, -100, 100);

    // ---- 自适应平滑（L1744–1752；EA 的 5s 刷新 → 我们的每根 K 线）----
    if (force || !this.initialized) {
      this.score = targetScore;
      this.initialized = true;
    } else {
      const flipping = this.score * targetScore < 0;
      const expanding = Math.abs(targetScore) > Math.abs(this.score);
      const adapt = flipping ? 0.8 : expanding ? 0.55 : 0.22;
      this.score = clampD(this.score + (targetScore - this.score) * adapt, -100, 100);
    }

    // ---- 粘滞方向域机（L1761–1786）----
    // chop 用 1x 框架（EA 用 M1=执行周期）：0.55(1−ER30)+0.45·Chop20/100
    const closes1x = candles.map((c) => c.close);
    const highs1x = candles.map((c) => c.high);
    const lows1x = candles.map((c) => c.low);
    if (candles.length >= 52) {
      const erM1 = efficiencyRatio(closes1x, 30).er;
      const chopM1 = choppinessIndex(highs1x, lows1x, closes1x, 20) / 100;
      this.chop = clampD(0.55 * (1 - erM1) + 0.45 * chopM1, 0, 1);
    }
    const absScore = Math.abs(this.score);
    const desiredDir = this.score > 0 ? 1 : this.score < 0 ? -1 : 0;
    if (this.chop > cfg.chopGate) {
      this.dir = 0; // 震荡市强制双向网格（反鞭甩）
    } else if (this.dir === 0) {
      if (absScore >= cfg.trendDirEnter) this.dir = desiredDir;
    } else if (desiredDir !== 0 && desiredDir !== this.dir && absScore >= cfg.trendDirEnter) {
      this.dir = desiredDir; // 足够的反向证据才翻向
    } else if (absScore <= cfg.trendDirExit) {
      this.dir = 0;
    }

    const snap: RegimeSnapshot = {
      score: this.score,
      scoreRaw: baseScore,
      scoreTarget: targetScore,
      state: marketStateFromScore(this.score, cfg),
      stateText: STATE_TEXT[marketStateFromScore(this.score, cfg)] ?? '震荡',
      dir: this.dir,
      chop: this.chop,
      coherence,
      conflict,
      strength: clampD(weightedTrend / weightSum, 0, 1),
      frames,
    };
    this.last = snap;
    return snap;
  }

  get current(): RegimeSnapshot | null {
    return this.last;
  }
}
