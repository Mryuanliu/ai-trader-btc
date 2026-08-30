import { describe, expect, it } from 'vitest';
import { applyFuturesFill, computeFuturesPosition, emptyFuturesPosition } from '../../position';

const S = 'BTCUSDT';

describe('applyFuturesFill 合约净持仓语义', () => {
  it('无持仓开多：净持仓为正', () => {
    const s = applyFuturesFill(emptyFuturesPosition(S), { side: 'BUY', quantity: 1, price: 100, fee: 0 });
    expect(s.netQty).toBe(1);
    expect(s.entryPrice).toBe(100);
  });

  it('无持仓开空：净持仓为负', () => {
    const s = applyFuturesFill(emptyFuturesPosition(S), { side: 'SELL', quantity: 1, price: 100, fee: 0 });
    expect(s.netQty).toBe(-1);
    expect(s.entryPrice).toBe(100);
  });

  it('同向加仓：加权均价', () => {
    let s = emptyFuturesPosition(S);
    s = applyFuturesFill(s, { side: 'BUY', quantity: 1, price: 100, fee: 0 });
    s = applyFuturesFill(s, { side: 'BUY', quantity: 1, price: 200, fee: 0 });
    expect(s.netQty).toBe(2);
    expect(s.entryPrice).toBe(150);
  });

  it('反向平仓：兑现已实现盈亏（多头 100→110 卖出赚 10）', () => {
    let s = emptyFuturesPosition(S);
    s = applyFuturesFill(s, { side: 'BUY', quantity: 1, price: 100, fee: 0 });
    s = applyFuturesFill(s, { side: 'SELL', quantity: 1, price: 110, fee: 1 });
    expect(s.netQty).toBe(0);
    expect(s.entryPrice).toBe(0);
    expect(s.realizedPnl).toBeCloseTo(9, 10); // 10 − 1 手续费
  });

  it('空头平仓盈亏反向：100 开空 90 买入平 → 盈利 10', () => {
    let s = emptyFuturesPosition(S);
    s = applyFuturesFill(s, { side: 'SELL', quantity: 1, price: 100, fee: 0 });
    s = applyFuturesFill(s, { side: 'BUY', quantity: 1, price: 90, fee: 0 });
    expect(s.netQty).toBe(0);
    expect(s.realizedPnl).toBeCloseTo(10, 10);
  });

  it('反向超过持仓：先平后反手，剩余量以成交价开新仓', () => {
    let s = emptyFuturesPosition(S);
    s = applyFuturesFill(s, { side: 'BUY', quantity: 1, price: 100, fee: 0 });
    // 卖出 3：1 平多（100→110 盈利 10）+ 2 反手开空 @110
    s = applyFuturesFill(s, { side: 'SELL', quantity: 3, price: 110, fee: 0 });
    expect(s.netQty).toBe(-2);
    expect(s.entryPrice).toBe(110);
    expect(s.realizedPnl).toBeCloseTo(10, 10);
  });

  it('纯函数：不修改入参状态', () => {
    const original = emptyFuturesPosition(S);
    applyFuturesFill(original, { side: 'BUY', quantity: 1, price: 100, fee: 0 });
    expect(original.netQty).toBe(0);
  });
});

describe('computeFuturesPosition 推导与估值', () => {
  it('由成交序列推导净持仓与未实现盈亏', () => {
    const p = computeFuturesPosition(
      S,
      [
        { side: 'SELL', quantity: 2, price: 100, fee: 0 },
        { side: 'BUY', quantity: 1, price: 90, fee: 0 },
      ],
      80,
    );
    // 开空 2 @100，平 1 @90（盈利 10），剩净空 1 @100
    expect(p.netQty).toBe(-1);
    expect(p.entryPrice).toBe(100);
    expect(p.realizedPnl).toBeCloseTo(10, 10);
    // 未实现：净空 1，现价 80 → (100−80)×1 = 20
    expect(p.unrealizedPnl).toBeCloseTo(20, 10);
    expect(p.notional).toBeCloseTo(80, 10);
  });
});
