import { describe, expect, it } from 'vitest';
import { computePnlPct, evaluateExitRules } from '../exit-rules';

const ENTRY = 78_000;

describe('computePnlPct 方向感知盈亏', () => {
  it('多头：价格上涨为正，下跌为负', () => {
    expect(computePnlPct(ENTRY, 80_000, 'LONG')).toBeCloseTo(0.025641, 6);
    expect(computePnlPct(ENTRY, 76_000, 'LONG')).toBeCloseTo(-0.025641, 6);
  });

  it('空头：价格下跌为正，上涨为负（与多头相反）', () => {
    expect(computePnlPct(ENTRY, 76_000, 'SHORT')).toBeCloseTo(0.025641, 6);
    expect(computePnlPct(ENTRY, 80_000, 'SHORT')).toBeCloseTo(-0.025641, 6);
  });

  it('side 为 null 时按多头处理（现货场景）', () => {
    expect(computePnlPct(ENTRY, 80_000, null)).toBe(computePnlPct(ENTRY, 80_000, 'LONG'));
  });

  it('开仓价为 0 时返回 0，不产生 Infinity', () => {
    expect(computePnlPct(0, 80_000, 'LONG')).toBe(0);
  });
});

describe('evaluateExitRules 出场判定', () => {
  const rules = { stopLossPct: 0.05, takeProfitPct: 0.1 };

  it('多头亏损达标触发止损，平仓动作是卖出', () => {
    const r = evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 0.9, side: 'LONG', exitRules: rules });
    expect(r.triggered).toBe(true);
    expect(r.kind).toBe('stopLoss');
    expect(r.closeAction).toBe('SELL');
  });

  it('多头盈利达标触发止盈', () => {
    const r = evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 1.2, side: 'LONG', exitRules: rules });
    expect(r.triggered).toBe(true);
    expect(r.kind).toBe('takeProfit');
    expect(r.closeAction).toBe('SELL');
  });

  it('空头反向：价格上涨才亏损，触发止损且平仓动作是买入', () => {
    // 空头踩坑点：若按多头公式算，价格下跌会被误判为止损
    const r = evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 1.1, side: 'SHORT', exitRules: rules });
    expect(r.triggered).toBe(true);
    expect(r.kind).toBe('stopLoss');
    expect(r.closeAction).toBe('BUY'); // 空头平仓必须买入
  });

  it('空头盈利：价格下跌触发止盈', () => {
    const r = evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 0.85, side: 'SHORT', exitRules: rules });
    expect(r.triggered).toBe(true);
    expect(r.kind).toBe('takeProfit');
    expect(r.closeAction).toBe('BUY');
  });

  it('未达阈值不触发', () => {
    const r = evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 1.01, side: 'LONG', exitRules: rules });
    expect(r.triggered).toBe(false);
    expect(r.kind).toBeNull();
    expect(r.closeAction).toBeNull();
  });

  it('规则全关时永不触发（默认配置）', () => {
    const closed = { stopLossPct: null, takeProfitPct: null };
    for (const price of [ENTRY * 0.5, ENTRY, ENTRY * 2]) {
      for (const side of ['LONG', 'SHORT', null] as const) {
        expect(
          evaluateExitRules({ entryPrice: ENTRY, price, side, exitRules: closed }).triggered,
        ).toBe(false);
      }
    }
  });

  it('只配止损时止盈不生效，反之亦然', () => {
    const onlyStop = { stopLossPct: 0.05, takeProfitPct: null };
    const onlyTake = { stopLossPct: null, takeProfitPct: 0.1 };

    // 大涨：只配止损 -> 不触发（未配止盈）
    expect(
      evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 1.5, side: 'LONG', exitRules: onlyStop })
        .triggered,
    ).toBe(false);
    // 大跌：只配止盈 -> 不触发（未配止损）
    expect(
      evaluateExitRules({ entryPrice: ENTRY, price: ENTRY * 0.5, side: 'LONG', exitRules: onlyTake })
        .triggered,
    ).toBe(false);
  });

  it('价格非法时不触发，避免误平仓', () => {
    for (const price of [0, -1, Number.NaN]) {
      expect(
        evaluateExitRules({ entryPrice: ENTRY, price, side: 'LONG', exitRules: rules }).triggered,
      ).toBe(false);
    }
  });
});
