// ---------------------------------------------------------------------------
// M3 挂单与网格维护纪律（方案 M3 / W4）——纯函数层
//
// 移植自 king-v4-balance.mq5，由策略的 usePendingDiscipline 开关守护消费：
// - 回归确认加层（G9）：TryPlacePendingOrders L4071–4074 / L4100–4103。
//   EA 判据 target=ask+step ≤ lowest_position−step ⟺ 现价走远 **2 个网格**；
//   极值 *_any 口径 = 持仓 ∪ 挂单 取极（CollectStats L2139–2177）。
//   老移植的 1 格版是走样（G9），这里恢复原语义并加合并极值地板。
// - 再平衡加层（G9 后半）：失衡比 >3 且差额 > 2×baseQty（EA 0.2 手折算）时，
//   允许突破本方极值继续挂层（L4053–4054/L4073）。
// - 挂单跟踪（G8）：TryTrailPendingOrders L4125–4181，只向现价方向跟，
//   偏离 ≥ pendingTrailStepPct·price 才撤旧换新。
// - 保证金/敞口预检（G11）：CanAffordOrder L1936 双系数原样
//   （free > margin×1.15 && equity > margin×1.25）。
// - 触发价距离地板：StopOrderMinDistancePoints（L1882，MT5 freeze/stop-level 概念）
//   在币安 algoOrder 无对应物，简化为 minTriggerDistPct 单一参数（M3-8）。
// - funding 窗暂停开层：MT5 时段语义的 BTC 24/7 对应物（方案 §5 换算表，
//   并入 M3-5 护栏），币安 funding 结算 UTC 00/08/16 ±15min。
// ---------------------------------------------------------------------------

export type Side = 'LONG' | 'SHORT';

/** 本侧极值（价格口径），null = 对应集合为空。持仓与「持仓∪挂单」各一对 */
export interface ExtremeBundle {
  /** 持仓最低价（EA buy_lowest_position 来源） */
  lowestPos: number | null;
  /** 持仓最高价（EA sell_highest_position 来源） */
  highestPos: number | null;
  /** 持仓 ∪ 挂单 最低价（EA *_lowest_any） */
  lowestAny: number | null;
  /** 持仓 ∪ 挂单 最高价（EA *_highest_any） */
  highestAny: number | null;
}

/** 极值合并口径（EA CollectStats L2112–2177）：openLots 与 openOrders 并集取极 */
export function sideExtremes(
  lots: Array<{ entryPrice: number }>,
  orders: Array<{ stopPrice: number }>,
): ExtremeBundle {
  const lotPrices = lots.map((l) => l.entryPrice);
  const prices = [...lotPrices, ...orders.map((o) => o.stopPrice)];
  return {
    lowestPos: lotPrices.length > 0 ? Math.min(...lotPrices) : null,
    highestPos: lotPrices.length > 0 ? Math.max(...lotPrices) : null,
    lowestAny: prices.length > 0 ? Math.min(...prices) : null,
    highestAny: prices.length > 0 ? Math.max(...prices) : null,
  };
}

/** 加层途径：首层（无持仓）/ 回归确认 / 再平衡突破 */
export type AddVia = 'first' | 'regression' | 'rebalance';

/**
 * 是否满足挂下一层的资格（EA buy_condition/sell_condition，L4071/L4100）。
 * 回归 = 现价相对最不利持仓逆行 2 格，且相对合并极值逆行 1 格；
 * 再平衡 = 失衡资格成立且现价已突破本方极值（target 极值+1 格自动满足）。
 */
export function canAddLayer(args: {
  side: Side;
  price: number;
  step: number;
  ext: ExtremeBundle;
  rebalance: boolean;
}): AddVia | null {
  const { side, price, step, ext, rebalance } = args;
  // 最不利持仓价：LONG 看最低（下跌摊平侧）、SHORT 看最高
  const worstPos = side === 'LONG' ? ext.lowestPos : ext.highestPos;
  if (worstPos == null) return 'first';
  if (side === 'LONG') {
    const regressed = price <= worstPos - 2 * step && (ext.lowestAny == null || price <= ext.lowestAny - step);
    if (regressed) return 'regression';
    if (rebalance && ext.highestAny != null && price >= ext.highestAny) return 'rebalance';
    return null;
  }
  const regressed = price >= worstPos + 2 * step && (ext.highestAny == null || price >= ext.highestAny + step);
  if (regressed) return 'regression';
  if (rebalance && ext.lowestAny != null && price <= ext.lowestAny) return 'rebalance';
  return null;
}

/** 再平衡失衡资格（EA L4053–4054）：对方/本方 > ratio 且差额 > 2×baseQty */
export function rebalanceEligible(args: {
  ourQty: number;
  oppQty: number;
  baseQty: number;
  ratio: number;
}): boolean {
  const { ourQty, oppQty, baseQty, ratio } = args;
  if (!(ourQty > 0) || !(oppQty > 0)) return false;
  return oppQty / ourQty > ratio && oppQty - ourQty > 2 * baseQty;
}

/** 挂单跟踪判定（EA L4160/L4178）：只向现价方向跟，达到地板距离才值得撤换 */
export function shouldTrail(side: Side, pendingPrice: number, target: number, trailDist: number): boolean {
  if (side === 'LONG') return pendingPrice - target >= trailDist;
  return target - pendingPrice >= trailDist;
}

/** 触发价距离地板（M3-8）：STOP 触发价与判定价保持最小距离，防贴价即触 */
export function applyTriggerFloor(side: Side, stopPrice: number, price: number, minDistPct: number): number {
  const floor = price * minDistPct;
  return side === 'LONG' ? Math.max(stopPrice, price + floor) : Math.min(stopPrice, price - floor);
}

/** 保证金预检（EA CanAffordOrder L1936）：预计占用 = 名义/杠杆，双系数严格大于 */
export function marginPrecheck(args: {
  availableMargin: number;
  equity: number;
  notional: number;
  leverage: number;
  freeK: number;
  equityK: number;
}): boolean {
  const { availableMargin, equity, notional, leverage, freeK, equityK } = args;
  if (!(notional > 0) || !(leverage > 0)) return false;
  const margin = notional / leverage;
  return availableMargin > margin * freeK && equity > margin * equityK;
}

/** funding 结算窗（币安 8h 周期，UTC 00/08/16）±windowMs 内 → 暂停开新层 */
export function nearFundingWindow(nowMs: number, windowMs = 15 * 60_000): boolean {
  const period = 8 * 3600_000;
  const ms = ((nowMs % period) + period) % period;
  return ms < windowMs || period - ms < windowMs;
}
