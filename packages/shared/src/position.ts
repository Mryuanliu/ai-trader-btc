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
