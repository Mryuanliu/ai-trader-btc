import { describe, expect, it } from 'vitest';
import {
  applyFuturesFill,
  computeFuturesPosition,
  computeFuturesRoundTrips,
  emptyFuturesPosition,
  type RoundTripFill,
} from '../position';

/**
 * 回合配对的核心验收：**各回合 netPnl 之和必须等于持仓模型的 realizedPnl**。
 * 口径对不上，用户就会看到"订单页说赚了、持仓页说亏了"——比没有这列更糟。
 */

const T0 = 1_700_000_000_000;
function fill(
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  fee = 0,
  offsetMin = 0,
  orderId?: string,
): RoundTripFill {
  return { side, quantity, price, fee, time: T0 + offsetMin * 60_000, orderId };
}


describe('合约回合配对（computeFuturesRoundTrips）', () => {
  it('多头回合：netPnl = (卖-买)×量-平仓费，与 applyFuturesFill 链条 realizedPnl 一致', () => {
    const fills = [
      fill('BUY', 1, 100, 1, 0, 'o1'),
      fill('SELL', 1, 110, 1, 10, 'o2'),
    ];
    const { trips, summary } = computeFuturesRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ direction: 'long', qty: 1, entryPrice: 100, exitPrice: 110 });
    expect(trips[0].netPnl).toBeCloseTo(10 - 1, 8); // 只扣平仓费（现有持仓口径）
    // 口径对齐
    let st = emptyFuturesPosition('X');
    for (const f of fills) st = applyFuturesFill(st, f);
    expect(summary.totalNetPnl).toBeCloseTo(st.realizedPnl, 8);
  });

  it('空头回合：开空后买回，方向 short，下跌盈利', () => {
    const fills = [
      fill('SELL', 1, 110, 0, 0, 'o1'), // 开空 @110
      fill('BUY', 1, 100, 0, 10, 'o2'), // 买回 @100
    ];
    const { trips } = computeFuturesRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0].direction).toBe('short');
    expect(trips[0].netPnl).toBeCloseTo(10, 8); // (110-100)×1
  });

  it('先平后反手：一单反向超过持仓，产生平仓回合 + 新开仓', () => {
    const fills = [
      fill('BUY', 1, 100, 0, 0, 'o1'), // 多 1
      fill('SELL', 3, 110, 0, 10, 'o2'), // 平 1 + 反手空 2
      fill('BUY', 2, 90, 0, 20, 'o3'), // 空头买回
    ];
    const { trips } = computeFuturesRoundTrips(fills);
    expect(trips).toHaveLength(2);
    // 回合1：平多 1 份 @(110-100)
    expect(trips[0]).toMatchObject({ direction: 'long', qty: 1, exitPrice: 110, closeOrderId: 'o2' });
    expect(trips[0].netPnl).toBeCloseTo(10, 8);
    // 回合2：空头 2 份，开仓价 110（反手价），买回 90
    expect(trips[1]).toMatchObject({ direction: 'short', qty: 2, entryPrice: 110, exitPrice: 90, closeOrderId: 'o3' });
    expect(trips[1].netPnl).toBeCloseTo(40, 8);
    // 口径对齐
    let st = emptyFuturesPosition('X');
    for (const f of fills) st = applyFuturesFill(st, f);
    expect(computeFuturesRoundTrips(fills).summary.totalNetPnl).toBeCloseTo(st.realizedPnl, 8);
  });

  it('加仓后平仓：entryPrice 为加权均价', () => {
    const fills = [
      fill('BUY', 1, 100, 0, 0, 'o1'),
      fill('BUY', 1, 104, 0, 5, 'o2'), // 加权 102
      fill('SELL', 2, 110, 0, 10, 'o3'),
    ];
    const { trips } = computeFuturesRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0].entryPrice).toBeCloseTo(102, 8);
    expect(trips[0].netPnl).toBeCloseTo(16, 8); // (110-102)×2
  });

  it('与 computeFuturesPosition 口径对齐（含费用）', () => {
    const fills = [
      fill('BUY', 2, 100, 2, 0, 'o1'),
      fill('SELL', 1, 105, 1, 10, 'o2'),
      fill('SELL', 1, 108, 1, 20, 'o3'),
    ];
    const { summary } = computeFuturesRoundTrips(fills);
    const pos = computeFuturesPosition('X', fills, 0);
    expect(summary.totalNetPnl).toBeCloseTo(pos.realizedPnl, 8);
    // 部分平仓 → 两个回合
    expect(summary.count).toBe(2);
  });

  it('summary 统计正确（胜率/最佳/最差）', () => {
    const fills = [
      fill('BUY', 1, 100, 0, 0, 'o1'),
      fill('SELL', 1, 110, 0, 10, 'o2'), // +10
      fill('BUY', 1, 105, 0, 20, 'o3'),
      fill('SELL', 1, 95, 0, 30, 'o4'), // -10
    ];
    const { summary } = computeFuturesRoundTrips(fills);
    expect(summary).toMatchObject({ count: 2, wins: 1, losses: 1, winRate: 0.5 });
    expect(summary.bestPnl).toBeCloseTo(10, 8);
    expect(summary.worstPnl).toBeCloseTo(-10, 8);
    expect(summary.totalNetPnl).toBeCloseTo(0, 8);
  });
});
