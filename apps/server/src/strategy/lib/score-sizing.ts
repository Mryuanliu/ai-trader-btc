// ---------------------------------------------------------------------------
// 评分驱动三件套（方案 M2 / W3）：间距 / 马丁倍率 / 篮子与分侧目标
//
// 移植自 king-v4-balance.mq5，形状逐段对照、点值按方案 §5 换算表折成倍率：
// - DirectionalGridStepPoints（L1519–1541）→ directionalStep：以震荡域基准间距 s0
//   为锚，过渡带拉宽 +25%（EA 100→140 语义）、趋势域顺势加密至 0.75×（120→90）、
//   逆势再拉宽 +8.3%（140→150）。
// - DynamicLotMultiplier（L1638–1656）→ scoreLotMultiplier：震荡域用网格倍率、
//   强趋势压平到 trendMultMin（近等权）、中间线性渐变；顺势/逆势共用（EA 即如此）。
// - DynamicCloseAllTarget（L1659–1672）→ basketStartNow：启动线 ×(1+kAmp·strength)。
// - DynamicSideAverageOrderNetProfit（L1674–1686）→ sideTargetMult：
//   顺势 +60%、逆势 ×(1−0.28s)（EA 自然下限 0.72，计划文档另加 0.3 保底，二者等效）。
// - MarketTrendStrength01（L1543–1552）→ trendStrength01 原式。
// ---------------------------------------------------------------------------

export type Side = 'LONG' | 'SHORT';

export interface SizingCfg {
  /** 震荡域上界（EA RANGE_LIMIT=20） */
  trendRange: number;
  /** 确认域下界（EA TREND_CONFIRM=45） */
  trendConfirm: number;
  /** 强趋势下界（EA STRONG_TREND=70） */
  trendStrong: number;
  /** 过渡/趋势域逆势拉宽斜率（EA 100→140 / 140→150） */
  kStepCounter: number;
  /** 趋势域顺势加密斜率（EA 120→90） */
  kStepTrend: number;
  /** 篮子目标幅度系数（EA CloseAllAmplifier 内 0.80，L1671） */
  basketAmpK: number;
}

/** EA MarketTrendStrength01 L1543–1552：(|score|−range)/(100−range)，震荡域为 0 */
export function trendStrength01(score: number, trendRange: number): number {
  const abs = Math.abs(score);
  if (abs <= trendRange) return 0;
  return Math.min(1, Math.max(0, (abs - trendRange) / (100 - trendRange)));
}

/**
 * 方向不对称间距（EA DirectionalGridStepPoints L1519–1541 的倍率形态）。
 * score 符号 = 趋势方向（>0 看多）；side 与该方向比较决定加密/拉宽。
 */
export function directionalStep(s0: number, score: number, side: Side, cfg: SizingCfg): number {
  const abs = Math.abs(score);
  if (abs <= cfg.trendRange) return s0; // 震荡域：对称基准（EA L1525–1526）
  const trendSide = (score > 0) === (side === 'LONG');
  if (abs < cfg.trendConfirm) {
    // 过渡带（20..45）：统一拉宽 ≤+25%（EA 逆势 100→140 语义；
    // 顺势侧 EA 保持基准，但过渡带证据不足时宽一点更安全，取计划定稿形状）
    const t = (abs - cfg.trendRange) / (cfg.trendConfirm - cfg.trendRange);
    return s0 * (1 + 0.25 * t);
  }
  // 确认/强趋势（≥45）：顺势加密、逆势拉宽（EA L1530–1536）
  const t = (abs - cfg.trendConfirm) / (100 - cfg.trendConfirm);
  if (trendSide) return s0 * Math.max(0.7, 1 - cfg.kStepTrend * t);
  return s0 * (1 + cfg.kStepCounter * t);
}

/**
 * 趋势压平马丁倍率（EA DynamicLotMultiplier L1638–1656 原式）：
 * 震荡域=gridMult、强趋势=trendMultMin、中间线性渐变。
 */
export function scoreLotMultiplier(
  score: number,
  gridMult: number,
  trendMultMin: number,
  cfg: Pick<SizingCfg, 'trendRange' | 'trendStrong'>,
): number {
  const abs = Math.abs(score);
  if (abs <= cfg.trendRange) return gridMult;
  if (abs >= cfg.trendStrong) return trendMultMin;
  const t = (abs - cfg.trendRange) / (cfg.trendStrong - cfg.trendRange);
  return gridMult - (gridMult - trendMultMin) * t;
}

/** 篮子追踪启动线动态化（EA DynamicCloseAllTarget L1671 的 (1+0.8·strength) 项） */
export function basketStartNow(baseStartPct: number, score: number, cfg: Pick<SizingCfg, 'trendRange' | 'basketAmpK'>): number {
  return baseStartPct * (1 + cfg.basketAmpK * trendStrength01(score, cfg.trendRange));
}

/**
 * 分侧均值目标倍率（EA DynamicSideAverageOrderNetProfit L1674–1686）：
 * 返回值乘上「该侧名义 × sideTargetPct」即为侧目标 USDT。
 */
export function sideTargetMult(score: number, side: Side, trendRange: number): number {
  const strength = trendStrength01(score, trendRange);
  if (strength <= 0) return 1;
  const trendSide = (score > 0) === (side === 'LONG');
  if (trendSide) return 1 + 0.6 * strength;
  return Math.max(0.3, 1 - 0.28 * strength);
}
