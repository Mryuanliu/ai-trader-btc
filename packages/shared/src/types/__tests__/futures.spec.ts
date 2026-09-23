import { describe, expect, it } from 'vitest';
import {
  computeFuturesOrderQty,
  isActionableIntent,
  resolveFuturesOrderIntentLot,
  resolveLotCloseIntent,
} from '../futures';
import { settleLotPnl } from '../../position';

describe('computeFuturesOrderQty 保证金仓位计算', () => {
  const base = {
    availableMargin: 5000,
    positionPct: 0.1,
    leverage: 5,
    price: 78_000,
    stepSize: 0.0001,
  };

  it('保证金 × 杠杆 = 名义价值，并按步进向下取整', () => {
    const r = computeFuturesOrderQty(base);
    // 保证金 500，名义 2500，数量 2500/78000 = 0.03205 -> 向下取整 0.0320
    expect(r.quantity).toBeCloseTo(0.032, 10);
    expect(r.notional).toBeCloseTo(0.032 * 78_000, 6);
    expect(r.margin).toBeCloseTo((0.032 * 78_000) / 5, 6);
    // 取整后占用保证金不得超过预算 500
    expect(r.margin).toBeLessThanOrEqual(500);
  });

  it('杠杆越高，名义价值越大', () => {
    const low = computeFuturesOrderQty({ ...base, leverage: 1 });
    const high = computeFuturesOrderQty({ ...base, leverage: 5 });
    expect(high.notional).toBeGreaterThan(low.notional);
    // 两者占用保证金一致（都由 positionPct 决定）
    expect(high.margin).toBeCloseTo(low.margin, 6);
  });

  it('非法入参返回数量 0 并给出原因', () => {
    expect(computeFuturesOrderQty({ ...base, availableMargin: 0 }).quantity).toBe(0);
    expect(computeFuturesOrderQty({ ...base, leverage: 0 }).note).toContain('杠杆');
    expect(computeFuturesOrderQty({ ...base, price: 0 }).note).toContain('价格');
    expect(computeFuturesOrderQty({ ...base, positionPct: 0 }).note).toContain('positionPct');
  });

  it('保证金预算过小时取整为 0，并说明原因', () => {
    const r = computeFuturesOrderQty({ ...base, availableMargin: 0.5, positionPct: 0.001 });
    expect(r.quantity).toBe(0);
    expect(r.note).toContain('取整后为 0');
  });
});
describe('resolveFuturesOrderIntentLot 方向语义映射（Lot 模型 / hedge mode）', () => {
  it('BUY 恒开多、SELL 恒开空，与当前净持仓无关', () => {
    // 关键差异：净持仓语义下「持多时 SELL=平多」；Lot 语义下 SELL=开空（多空共存）
    for (const qty of [-0.05, 0, 0.05]) {
      expect(resolveFuturesOrderIntentLot('BUY')).toEqual({
        kind: 'open',
        side: 'BUY',
        positionSide: 'LONG',
        reduceOnly: false,
      });
      expect(resolveFuturesOrderIntentLot('SELL')).toEqual({
        kind: 'open',
        side: 'SELL',
        positionSide: 'SHORT',
        reduceOnly: false,
      });
      void qty;
    }
  });

  it('HOLD 恒观望', () => {
    expect(resolveFuturesOrderIntentLot('HOLD').kind).toBe('hold');
    expect(isActionableIntent(resolveFuturesOrderIntentLot('HOLD'))).toBe(false);
  });

  it('Lot 平仓意图：平多=SELL reduceOnly LONG，平空=BUY reduceOnly SHORT', () => {
    expect(resolveLotCloseIntent('LONG')).toEqual({
      kind: 'close',
      side: 'SELL',
      positionSide: 'LONG',
      reduceOnly: true,
    });
    expect(resolveLotCloseIntent('SHORT')).toEqual({
      kind: 'close',
      side: 'BUY',
      positionSide: 'SHORT',
      reduceOnly: true,
    });
  });
});

describe('settleLotPnl 逐单结算', () => {
  it('多头结算：毛盈亏 − 双边手续费，收益率为名义口径', () => {
    const r = settleLotPnl({
      direction: 'LONG',
      quantity: 1,
      entryPrice: 100,
      exitPrice: 110,
      entryFee: 0.1,
      exitFee: 0.1,
    });
    expect(r.realizedPnl).toBeCloseTo(9.8, 8);
    expect(r.returnPct).toBeCloseTo(0.098, 8);
  });

  it('空头结算方向相反', () => {
    const r = settleLotPnl({
      direction: 'SHORT',
      quantity: 1,
      entryPrice: 100,
      exitPrice: 90,
      entryFee: 0,
      exitFee: 0,
    });
    expect(r.realizedPnl).toBeCloseTo(10, 8);
  });
});
