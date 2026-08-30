import { describe, expect, it } from 'vitest';
import {
  computeFuturesOrderQty,
  isActionableIntent,
  resolveFuturesOrderIntent,
} from '../futures';

describe('resolveFuturesOrderIntent 方向语义映射', () => {
  it('无持仓时 BUY=开多、SELL=开空', () => {
    expect(resolveFuturesOrderIntent('BUY', 0)).toEqual({
      kind: 'open',
      side: 'BUY',
      positionSide: 'LONG',
      reduceOnly: false,
    });
    expect(resolveFuturesOrderIntent('SELL', 0)).toEqual({
      kind: 'open',
      side: 'SELL',
      positionSide: 'SHORT',
      reduceOnly: false,
    });
  });

  it('持多时 BUY=加多、SELL=平多(reduceOnly)', () => {
    expect(resolveFuturesOrderIntent('BUY', 0.05)).toEqual({
      kind: 'add',
      side: 'BUY',
      positionSide: 'LONG',
      reduceOnly: false,
    });
    expect(resolveFuturesOrderIntent('SELL', 0.05)).toEqual({
      kind: 'close',
      side: 'SELL',
      positionSide: 'LONG',
      reduceOnly: true,
    });
  });

  it('持空时 SELL=加空、BUY=平空(reduceOnly)', () => {
    expect(resolveFuturesOrderIntent('SELL', -0.05)).toEqual({
      kind: 'add',
      side: 'SELL',
      positionSide: 'SHORT',
      reduceOnly: false,
    });
    expect(resolveFuturesOrderIntent('BUY', -0.05)).toEqual({
      kind: 'close',
      side: 'BUY',
      positionSide: 'SHORT',
      reduceOnly: true,
    });
  });

  it('HOLD 在任何持仓下都是观望', () => {
    for (const qty of [-0.05, 0, 0.05]) {
      const intent = resolveFuturesOrderIntent('HOLD', qty);
      expect(intent.kind).toBe('hold');
      expect(isActionableIntent(intent)).toBe(false);
    }
  });

  it('反向信号只平仓不反手：平多后同信号下一周期才开空', () => {
    // 第一跳：持多遇 SELL -> 只平
    const first = resolveFuturesOrderIntent('SELL', 0.05);
    expect(first.kind).toBe('close');
    expect(first.reduceOnly).toBe(true);

    // 第二跳：假设已平完（qty=0），同样 SELL -> 开空
    const second = resolveFuturesOrderIntent('SELL', 0);
    expect(second.kind).toBe('open');
    expect(second.positionSide).toBe('SHORT');
  });

  it('平仓单必带 reduceOnly，防止反向开仓放大风险', () => {
    const closes = [
      resolveFuturesOrderIntent('SELL', 0.05),
      resolveFuturesOrderIntent('BUY', -0.05),
    ];
    for (const c of closes) {
      expect(c.kind).toBe('close');
      expect(c.reduceOnly).toBe(true);
    }
  });
});

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
