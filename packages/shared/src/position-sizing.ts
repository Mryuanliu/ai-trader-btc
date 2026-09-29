/**
 * 波动率定标仓位（Vol-targeted position sizing）。
 *
 * 调研文档 `strategy-marketplace-research.md` L1/Kim-Tse-Wald 的核心：
 * **方向性「稳」的第一来源不是信号，而是仓位规则**。同一份入场信号，
 * 用固定张数下单 vs 按当前波动率反比缩放，Sharpe/最大回撤差数倍。
 *
 * 公式：
 * - `notional = equity · riskPerTradePct / 100 · atrMult / (atr / markPrice)`
 *   → 每笔「在 atrMult·ATR 的距离内被打损」时恰好亏 `riskPerTradePct%` 权益
 * - 名义值封顶 `maxNotional`（默认 `equity · maxLeverage`）
 * - `leverage = clamp(ceil(notional/equity), 1, maxLeverage)`
 * - `quantity = notional / markPrice`
 *
 * 定位：**共享工具函数、策略自接**——平台不拦截，策略自主决定是否用引擎。
 * 边界（equity/atr/markPrice 任一 ≤ 0）返回 0，让调用方自然跳过开仓。
 */
export interface RiskSizedArgs {
  /** USDT 权益（可用保证金或账户权益，由调用方决定口径） */
  equity: number;
  /** 当前 ATR（与 markPrice 同价货币） */
  atr: number;
  /** 标记价，用 last price 会被单笔大额成交「插针」扭曲 */
  markPrice: number;
  /** 单笔风险预算，0.5 = 权益的 0.5% */
  riskPerTradePct: number;
  /** 止损距离的 ATR 倍数（默认 1）；吊灯常用 3，定标用 1 更保守 */
  atrMult?: number;
  /** 上限杠杆（默认 10） */
  maxLeverage?: number;
  /** 名义值上限（USDT，默认 equity·maxLeverage） */
  maxNotional?: number;
}

export interface RiskSizedResult {
  /** 下单数量（币安合约 base asset 单位） */
  quantity: number;
  /** 名义价值（USDT） */
  notional: number;
  /** 建议杠杆（策略透传给 openLot.leverage） */
  leverage: number;
}

/** 主入口：任何非正边界 → 返回零仓位，调用方自行跳过 */
export function computeRiskScaledQty(args: RiskSizedArgs): RiskSizedResult {
  const {
    equity,
    atr,
    markPrice,
    riskPerTradePct,
    atrMult = 1,
    maxLeverage = 10,
  } = args;
  if (!(equity > 0) || !(atr > 0) || !(markPrice > 0) || !(riskPerTradePct > 0)) {
    return { quantity: 0, notional: 0, leverage: 0 };
  }
  const maxNotional = args.maxNotional ?? equity * maxLeverage;
  // 推导：设 quantity · atrMult · atr = equity · riskPct/100
  // → quantity = equity · riskPct/100 / (atrMult · atr)
  // → notional = quantity · markPrice = equity · riskPct/100 / (atrMult · atrPct)，其中 atrPct = atr/markPrice
  const atrPct = atr / markPrice;
  let notional = (equity * riskPerTradePct) / 100 / (atrMult * atrPct);
  if (!(notional > 0)) return { quantity: 0, notional: 0, leverage: 0 };
  if (notional > maxNotional) notional = maxNotional;
  const quantity = notional / markPrice;
  const rawLev = notional / equity;
  const leverage = Math.max(1, Math.min(maxLeverage, Math.ceil(rawLev)));
  return { quantity, notional, leverage };
}
