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

/** 空持仓快照，数据缺失或无成交时返回 */
export function emptyPosition(symbol: string): PositionSnapshot {
  return {
    symbol,
    quantity: 0,
    avgCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    marketValue: 0,
    totalBought: 0,
    totalSold: 0,
    totalFee: 0,
  };
}

/**
 * 由成交明细推导持仓，采用移动加权平均成本法。
 *
 * - 买入：数量增加，手续费计入成本（抬高均价）
 * - 卖出：按当前均价兑现已实现盈亏，成本等比例减少，均价不变
 *
 * 不新建持仓表：trade_fills 已是事实来源，推导即可满足成本价与盈亏计算，
 * 避免与主订单表产生双写一致性问题。
 *
 * @param fills 必须按成交时间升序传入
 * @param currentPrice 用于计算未实现盈亏与市值的现价
 */
export function computePosition(
  symbol: string,
  fills: PositionFill[],
  currentPrice: number,
): PositionSnapshot {
  const pos = emptyPosition(symbol);

  let quantity = 0;
  let avgCost = 0;

  for (const fill of fills) {
    const qty = Number(fill.quantity);
    const price = Number(fill.price);
    const fee = Number(fill.fee) || 0;
    if (!(qty > 0) || !(price > 0)) continue;

    if (fill.side === 'BUY') {
      // 手续费摊入成本：买入 1 BTC @ 100，手续费 10，实际成本 110
      const cost = qty * price + fee;
      const newQty = quantity + qty;
      avgCost = newQty > 0 ? (avgCost * quantity + cost) / newQty : 0;
      quantity = newQty;
      pos.totalBought += qty;
    } else {
      // 卖出数量不应超过持仓；超出部分按均价 0 处理，避免出现负成本
      const soldQty = Math.min(qty, quantity > 0 ? quantity : qty);
      const realized = (price - avgCost) * soldQty - fee;
      pos.realizedPnl += realized;
      quantity = Math.max(0, quantity - qty);
      if (quantity <= 0) {
        quantity = 0;
        avgCost = 0;
      }
      pos.totalSold += qty;
    }
    pos.totalFee += fee;
  }

  pos.quantity = quantity;
  pos.avgCost = avgCost;
  pos.marketValue = quantity * currentPrice;
  // 未实现盈亏按现价与均价的差额计，尚未扣卖出侧手续费
  pos.unrealizedPnl = quantity > 0 && currentPrice > 0 ? (currentPrice - avgCost) * quantity : 0;

  return pos;
}

// ---------------------------------------------------------------------------
// 合约净持仓模型（与现货的关键差异：可做空，净持仓可正可负）
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
