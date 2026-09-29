import { describe, expect, it } from 'vitest';
import { computeRiskScaledQty } from '../position-sizing';

/**
 * 波动率定标仓位（P1 L1）——手算样例钉死公式与封顶。
 * 核心不变量：quantity · atrMult · atr = equity · riskPct/100
 * （在 atrMult·ATR 距离内被打损，恰好亏 riskPct% 权益）
 */
describe('computeRiskScaledQty 波动率定标', () => {
  it('样例 1：atrMult=1 默认距离，BTC 10000U/risk0.5%/ATR50@mark60000', () => {
    const r = computeRiskScaledQty({
      equity: 10_000,
      atr: 50,
      markPrice: 60_000,
      riskPerTradePct: 0.5,
    });
    expect(r.notional).toBeCloseTo(60_000, 6);
    expect(r.quantity).toBeCloseTo(1, 6);
    // rawLev=6 → ceil 6 → clamp(1..10)=6
    expect(r.leverage).toBe(6);
    // 验证不变量
    expect(r.quantity * 1 * 50).toBeCloseTo(10_000 * 0.005, 6);
  });

  it('样例 2：atr 翻倍 → 仓位减半（反比缩放）', () => {
    const a = computeRiskScaledQty({
      equity: 10_000,
      atr: 50,
      markPrice: 60_000,
      riskPerTradePct: 0.5,
    });
    const b = computeRiskScaledQty({
      equity: 10_000,
      atr: 100,
      markPrice: 60_000,
      riskPerTradePct: 0.5,
    });
    expect(b.notional).toBeCloseTo(a.notional / 2, 6);
    expect(b.quantity).toBeCloseTo(a.quantity / 2, 6);
  });

  it('样例 3：atrMult=3 与吊灯 K=3 匹配，同预算下名义值缩到 1/3', () => {
    const r = computeRiskScaledQty({
      equity: 10_000,
      atr: 50,
      markPrice: 60_000,
      riskPerTradePct: 0.5,
      atrMult: 3,
    });
    expect(r.notional).toBeCloseTo(20_000, 6);
    expect(r.quantity).toBeCloseTo(20_000 / 60_000, 6);
    // rawLev=2 → ceil 2
    expect(r.leverage).toBe(2);
    // 不变量：qty·3·50 = 0.5% equity
    expect(r.quantity * 3 * 50).toBeCloseTo(50, 6);
  });

  it('封顶：rawLev 超 maxLeverage → notional 缩至 equity·maxLeverage', () => {
    const r = computeRiskScaledQty({
      equity: 10_000,
      atr: 10,
      markPrice: 60_000,
      riskPerTradePct: 5, // 5% 风险 + 低波动 → 未封顶会算出 3,000,000 名义
      maxLeverage: 10,
    });
    // 未封顶应为 500·(60000/10) = 3,000,000，封顶至 100,000
    expect(r.notional).toBeCloseTo(100_000, 6);
    expect(r.quantity).toBeCloseTo(100_000 / 60_000, 6);
    expect(r.leverage).toBe(10);
  });

  it('边界：equity/atr/markPrice 非正 → 返回零仓位（策略自然跳过开仓）', () => {
    expect(computeRiskScaledQty({ equity: 0, atr: 50, markPrice: 60_000, riskPerTradePct: 0.5 }).notional).toBe(0);
    expect(computeRiskScaledQty({ equity: 10_000, atr: 0, markPrice: 60_000, riskPerTradePct: 0.5 }).notional).toBe(0);
    expect(computeRiskScaledQty({ equity: 10_000, atr: 50, markPrice: 0, riskPerTradePct: 0.5 }).notional).toBe(0);
    expect(computeRiskScaledQty({ equity: 10_000, atr: 50, markPrice: 60_000, riskPerTradePct: 0 }).notional).toBe(0);
    expect(computeRiskScaledQty({ equity: -1, atr: 50, markPrice: 60_000, riskPerTradePct: 0.5 })).toEqual({
      quantity: 0,
      notional: 0,
      leverage: 0,
    });
  });

  it('maxNotional 显式传入 → 覆盖 equity·maxLeverage 默认', () => {
    const r = computeRiskScaledQty({
      equity: 10_000,
      atr: 10,
      markPrice: 60_000,
      riskPerTradePct: 5,
      maxNotional: 5_000,
    });
    expect(r.notional).toBeCloseTo(5_000, 6);
    // rawLev = 5000/10000 = 0.5 → ceil 1 → clamp(1..10) = 1
    expect(r.leverage).toBe(1);
  });
});
