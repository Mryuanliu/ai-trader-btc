import { PositionSnapshot } from './types/common';

/** 推导持仓所需的最小成交记录 */
export interface PositionFill {
  side: 'BUY' | 'SELL';
  /** 成交数量 */
  quantity: number;
  /** 成交单价 */
  price: number;
  /** 手续费，以计价资产（USDT）计 */
  fee: number;
}

// ---------------------------------------------------------------------------
// Position Lot（订单级仓位单）
// ---------------------------------------------------------------------------
// 每笔开仓订单 = 一个 Lot，独立止盈止损、全量平仓后才算完结。
// 1 开仓单 ↔ 1 Lot ↔ 1 平仓单，回合配对不再依赖 FIFO 启发式。

export type LotDirection = 'LONG' | 'SHORT';
export type LotStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
/** 出场原因：信号出场（预留）/止损/止盈/手动/反手解除 */
export type LotExitReason = 'SIGNAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'REVERSE';

/**
 * strategy 链路 / AI 降级时的逐单止盈止损兜底值（用户确认：SL 2% / TP 4%，盈亏比 2:1）。
 * hybrid 链路 AI 可逐单覆盖，但必须钳制到 [MIN_TP_SL, MAX_TP_SL] 防幻觉值。
 */
export const DEFAULT_LOT_STOP_LOSS_PCT = 0.02;
export const DEFAULT_LOT_TAKE_PROFIT_PCT = 0.04;
export const MIN_TP_SL_PCT = 0.005;
export const MAX_TP_SL_PCT = 0.1;

/** 把 AI/配置给出的止盈止损参数钳制到安全区间，非法值回落默认 */
export function clampLotTpSl(input: {
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
}): { stopLossPct: number; takeProfitPct: number } {
  const clamp = (v: number | null | undefined, d: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return d;
    return Math.min(Math.max(v, MIN_TP_SL_PCT), MAX_TP_SL_PCT);
  };
  return {
    stopLossPct: clamp(input.stopLossPct, DEFAULT_LOT_STOP_LOSS_PCT),
    takeProfitPct: clamp(input.takeProfitPct, DEFAULT_LOT_TAKE_PROFIT_PCT),
  };
}

/**
 * 逐 Lot 止盈止损判定（多头：跌破止损线/涨破止盈线；空头反向）。
 * 纯函数：决策循环、合约引擎、回测引擎共用同一判定，保证实盘与回测口径一致。
 *
 * @returns 触发类型；null = 未触发
 */
export function checkLotExit(params: {
  entryPrice: number;
  direction: LotDirection;
  stopLossPct: number;
  takeProfitPct: number;
  price: number;
}): 'STOP_LOSS' | 'TAKE_PROFIT' | null {
  const { entryPrice, direction, stopLossPct, takeProfitPct, price } = params;
  if (!(entryPrice > 0) || !(price > 0)) return null;

  if (direction === 'LONG') {
    if (price <= entryPrice * (1 - stopLossPct)) return 'STOP_LOSS';
    if (price >= entryPrice * (1 + takeProfitPct)) return 'TAKE_PROFIT';
  } else {
    if (price >= entryPrice * (1 + stopLossPct)) return 'STOP_LOSS';
    if (price <= entryPrice * (1 - takeProfitPct)) return 'TAKE_PROFIT';
  }
  return null;
}

/** Lot 结算：净盈亏（已扣双边手续费）与名义收益率 */
export function settleLotPnl(params: {
  direction: LotDirection;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryFee: number;
  exitFee: number;
}): { realizedPnl: number; returnPct: number } {
  const { direction, quantity, entryPrice, exitPrice, entryFee, exitFee } = params;
  const gross =
    direction === 'LONG'
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
  const realizedPnl = gross - entryFee - exitFee;
  const notional = entryPrice * quantity;
  return {
    realizedPnl: Number(realizedPnl.toFixed(8)),
    returnPct: notional > 0 ? Number((realizedPnl / notional).toFixed(8)) : 0,
  };
}

// ---------------------------------------------------------------------------
// 合约净持仓模型
// ---------------------------------------------------------------------------

/** 合约持仓状态：净持仓语义，数量为负表示空头 */
export interface FuturesPositionState {
  symbol: string;
  /** 净持仓：正=多头，负=空头，0=无持仓 */
  netQty: number;
  /** 开仓加权均价；无持仓时为 0 */
  entryPrice: number;
  /** 已实现盈亏（平仓兑现，手续费已扣） */
  realizedPnl: number;
  /** 累计手续费 */
  totalFee: number;
}

export function emptyFuturesPosition(symbol: string): FuturesPositionState {
  return { symbol, netQty: 0, entryPrice: 0, realizedPnl: 0, totalFee: 0 };
}

/** 数量绝对值小于该阈值视为已平净（消除浮点残留） */
const FLAT_EPSILON = 1e-12;

/**
 * 把一笔成交应用到合约净持仓上（**先平后反手**语义）。
 *
 * - 同向：加权均价加仓
 * - 反向不超过持仓：全部平掉，兑现已实现盈亏（多头 (卖-买)×量，空头 (买-卖)×量）
 * - 反向超过持仓：先按原均价平掉全部，剩余量以成交价反手开新仓
 *
 * 手续费在本函数内计入已实现盈亏与 totalFee；调用方勿再重复扣减。
 * 纯函数：返回新状态，不改入参。
 */
export function applyFuturesFill(
  state: FuturesPositionState,
  fill: PositionFill,
): FuturesPositionState {
  const qty = Number(fill.quantity);
  const price = Number(fill.price);
  const fee = Number(fill.fee) || 0;
  if (!(qty > 0) || !(price > 0)) return { ...state };

  const out: FuturesPositionState = {
    ...state,
    realizedPnl: state.realizedPnl,
    totalFee: state.totalFee + fee,
  };

  const dir = fill.side === 'BUY' ? 1 : -1;
  const holding = Math.abs(out.netQty) > FLAT_EPSILON ? out.netQty : 0;

  if (holding === 0) {
    // 无持仓：直接开仓
    out.netQty = dir * qty;
    out.entryPrice = price;
    return out;
  }

  const sameDir = Math.sign(dir) === Math.sign(holding);
  if (sameDir) {
    // 同向加仓：加权均价
    const absOld = Math.abs(holding);
    const absNew = absOld + qty;
    out.entryPrice = (out.entryPrice * absOld + price * qty) / absNew;
    out.netQty = holding + dir * qty;
    return out;
  }

  // 反向：先平掉与持仓重叠的部分
  const closeQty = Math.min(qty, Math.abs(holding));
  const holdSign = Math.sign(holding);
  const feeShare = (fee * closeQty) / qty;
  out.realizedPnl += holdSign * (price - out.entryPrice) * closeQty - feeShare;
  out.netQty = holding + dir * closeQty;

  const remain = qty - closeQty;
  if (remain > FLAT_EPSILON) {
    // 反向超过持仓：剩余数量反手开新仓
    out.netQty = dir * remain;
    out.entryPrice = price;
    return out;
  }
  // 恰好全部平掉：净持仓算术上已归零，钳掉浮点残留并把均价清零
  if (Math.abs(out.netQty) <= FLAT_EPSILON) {
    out.netQty = 0;
    out.entryPrice = 0;
  }
  return out;
}

/**
 * 由成交序列推导合约净持仓（fills 必须按成交时间升序）。
 * 回测与测试用；实盘持仓以交易所 positionRisk 为权威。
 */
export function computeFuturesPosition(
  symbol: string,
  fills: PositionFill[],
  markPrice: number,
): FuturesPositionState & { unrealizedPnl: number; notional: number } {
  let state = emptyFuturesPosition(symbol);
  for (const fill of fills) state = applyFuturesFill(state, fill);

  const unrealizedPnl = state.netQty !== 0 && markPrice > 0
    ? state.netQty * (markPrice - state.entryPrice)
    : 0;

  return {
    ...state,
    unrealizedPnl,
    notional: Math.abs(state.netQty) * markPrice,
  };
}

// ---------------------------------------------------------------------------
// 回合（Round Trip）明细：把「开仓 → 平仓」配对成一笔笔可展示的盈亏
// ---------------------------------------------------------------------------

/** 带时间与订单归属的成交（回合配对用；orders/trade_fills 查询结果直接可映射） */
export interface RoundTripFill extends PositionFill {
  /** 成交时间戳（ms） */
  time: number;
  /** 所属订单 ID，用于把回合关联回订单列表的某一行 */
  orderId?: string;
}

/** 一个完整回合（开仓→平仓）的盈亏明细 */
export interface RoundTrip {
  /** 方向 */
  direction: 'long' | 'short';
  /** 本回合平仓数量 */
  qty: number;
  /** 开仓均价（现货为含买入手续费的持有成本；合约为不含费的成交均价） */
  entryPrice: number;
  /** 平仓成交价 */
  exitPrice: number;
  /** 价差毛盈亏（未扣任何手续费） */
  grossPnl: number;
  /** 本回合分摊的手续费（开仓侧按数量比例 + 平仓侧），仅作展示，不参与 netPnl（见下） */
  fee: number;
  /**
   * 净盈亏。**与各自持仓模型的 realizedPnl 口径严格一致**：
   * - 现货：买入手续费已摊入成本，此处再扣卖出手续费
   * - 合约：只扣平仓侧手续费分摊（与 applyFuturesFill 一致；开仓费计入 totalFee、不进 realizedPnl，
   *   这是现有持仓模型的口径——回合求和与持仓面板对得上，不引入口径分裂）
   */
  netPnl: number;
  /** 收益率 = netPnl / (entryPrice × qty) */
  returnPct: number;
  /** 首笔开仓成交时间（ms） */
  openedAt: number;
  /** 平仓成交时间（ms） */
  closedAt: number;
  /** 平仓成交所属订单 ID（前端用它把盈亏标到订单列表的平仓行上） */
  closeOrderId?: string;
}

/** 回合汇总 */
export interface RoundTripSummary {
  count: number;
  wins: number;
  losses: number;
  /** 已实现净盈亏合计（= 各回合 netPnl 之和，与持仓面板 realizedPnl 同口径） */
  totalNetPnl: number;
  winRate: number;
  /** 最大单回合盈利 / 亏损 */
  bestPnl: number;
  worstPnl: number;
}

export function emptyRoundTripSummary(): RoundTripSummary {
  return { count: 0, wins: 0, losses: 0, totalNetPnl: 0, winRate: 0, bestPnl: 0, worstPnl: 0 };
}

function summarize(trips: RoundTrip[]): RoundTripSummary {
  const s = emptyRoundTripSummary();
  s.count = trips.length;
  for (const t of trips) {
    s.totalNetPnl += t.netPnl;
    if (t.netPnl > 0) s.wins += 1;
    else if (t.netPnl < 0) s.losses += 1;
    s.bestPnl = Math.max(s.bestPnl, t.netPnl);
    s.worstPnl = Math.min(s.worstPnl, t.netPnl);
  }
  s.totalNetPnl = Number(s.totalNetPnl.toFixed(8));
  s.winRate = s.count === 0 ? 0 : Number((s.wins / s.count).toFixed(4));
  return s;
}

/**
 * 合约回合配对（净持仓、先平后反手）。
 *
 * 口径与 applyFuturesFill 完全一致：同向加仓抬均价；反向先平后反手，
 * 平仓部分 netPnl = holdSign × (平价 − 开仓均价) × 量 − 平仓费按数量分摊。
 * 因此「各回合 netPnl 之和 === applyFuturesFill 链条的 realizedPnl」。
 *
 * fee 字段展示该回合相关的全部费用（开仓侧按数量比例 + 平仓侧分摊），
 * 但 netPnl 不扣开仓侧费用——与现有持仓模型口径一致（开仓费在 totalFee 里单独可查）。
 *
 * @param fills 必须按成交时间升序
 */
export function computeFuturesRoundTrips(fills: RoundTripFill[]): { trips: RoundTrip[]; summary: RoundTripSummary } {
  const trips: RoundTrip[] = [];
  let state = emptyFuturesPosition('rt');
  let openedAt = 0;
  /** 各方向已开仓数量（用于按比例分摊开仓费） */
  let openQtyAccum = 0;
  let openFeeAccum = 0;

  for (const fill of fills) {
    const qty = Number(fill.quantity);
    const price = Number(fill.price);
    const fee = Number(fill.fee) || 0;
    if (!(qty > 0) || !(price > 0)) continue;

    const dir = fill.side === 'BUY' ? 1 : -1;
    const holding = Math.abs(state.netQty) > FLAT_EPSILON ? state.netQty : 0;

    if (holding === 0) {
      // 开仓
      state = { ...state, netQty: dir * qty, entryPrice: price, totalFee: state.totalFee + fee };
      openedAt = fill.time;
      openQtyAccum = qty;
      openFeeAccum = fee;
      continue;
    }

    const sameDir = Math.sign(dir) === Math.sign(holding);
    if (sameDir) {
      const absOld = Math.abs(holding);
      const absNew = absOld + qty;
      state = {
        ...state,
        entryPrice: (state.entryPrice * absOld + price * qty) / absNew,
        netQty: holding + dir * qty,
        totalFee: state.totalFee + fee,
      };
      openQtyAccum += qty;
      openFeeAccum += fee;
      continue;
    }

    // 反向平仓（先平后反手）
    const closeQty = Math.min(qty, Math.abs(holding));
    const holdSign = Math.sign(holding);
    const feeShare = (fee * closeQty) / qty;
    const gross = holdSign * (price - state.entryPrice) * closeQty;
    const net = gross - feeShare; // 与 applyFuturesFill L161 逐字一致
    const openFeeShare = openQtyAccum > 0 ? (openFeeAccum * closeQty) / openQtyAccum : 0;
    trips.push({
      direction: holdSign > 0 ? 'long' : 'short',
      qty: closeQty,
      entryPrice: Number(state.entryPrice.toFixed(8)),
      exitPrice: price,
      grossPnl: Number(gross.toFixed(8)),
      fee: Number((openFeeShare + feeShare).toFixed(8)),
      netPnl: Number(net.toFixed(8)),
      returnPct: Number((net / (state.entryPrice * closeQty || 1)).toFixed(6)),
      openedAt,
      closedAt: fill.time,
      closeOrderId: fill.orderId,
    });

    const remain = qty - closeQty;
    // 与 applyFuturesFill L162/L165 逐字对齐：
    // 先按平仓量更新净持仓（holding + dir*closeQty，可能仍有剩余持仓），
    // 仅当本笔反向量超过持仓（remain>0）时才整体反手开新仓
    let newQty = holding + dir * closeQty;
    let newEntry = state.entryPrice;
    if (remain > FLAT_EPSILON) {
      newQty = dir * remain;
      newEntry = price;
    } else if (Math.abs(newQty) <= FLAT_EPSILON) {
      newQty = 0;
      newEntry = 0;
    }
    state = {
      ...state,
      realizedPnl: state.realizedPnl + net,
      totalFee: state.totalFee + fee,
      netQty: newQty,
      entryPrice: newEntry,
    };
    if (remain > FLAT_EPSILON) {
      // 反手：剩余量开新仓，其费用也计入新一轮
      openedAt = fill.time;
      openQtyAccum = remain;
      openFeeAccum = (fee * remain) / qty;
    } else {
      // 部分平仓：持仓仍在，开仓量与费用基数按平仓量递减（保持费用分摊正确）
      openQtyAccum = Math.max(0, openQtyAccum - closeQty);
    }
  }

  return { trips, summary: summarize(trips) };
}
