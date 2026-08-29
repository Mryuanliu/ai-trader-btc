import { describe, expect, it } from 'vitest';
import { computeMaxDrawdownPct, computeMetrics, computeSharpe } from './metrics';
import type { BacktestTrade, EquityPoint } from './types';

function curve(values: number[]): EquityPoint[] {
  return values.map((equity, i) => ({ time: 1_700_000_000_000 + i * 300_000, equity, drawdownPct: 0 }));
}

describe('computeMaxDrawdownPct', () => {
  it('单调上涨序列回撤为 0', () => {
    expect(computeMaxDrawdownPct(curve([100, 110, 120, 130]))).toBe(0);
  });

  it('已知回撤被正确计算', () => {
    // 峰值 130 → 谷值 91 → 回撤 30%
    expect(computeMaxDrawdownPct(curve([100, 130, 91, 120]))).toBe(30);
  });

  it('空序列返回 0', () => {
    expect(computeMaxDrawdownPct([])).toBe(0);
  });
});

describe('computeSharpe', () => {
  it('恒定收益（零波动）返回 0', () => {
    expect(computeSharpe([0.001, 0.001, 0.001], '5m')).toBe(0);
  });

  it('同均值下波动越大夏普越低', () => {
    const stable: number[] = Array.from({ length: 100 }, () => 0.0005);
    const volatile = stable.map((r, i) => (i % 2 === 0 ? r + 0.02 : r - 0.02));
    const wilder = stable.map((r, i) => (i % 2 === 0 ? r + 0.2 : r - 0.2));
    const s1 = computeSharpe(stable, '5m');
    const s2 = computeSharpe(volatile, '5m');
    const s3 = computeSharpe(wilder, '5m');
    expect(s1).toBe(0); // 零波动
    expect(s2).toBeGreaterThan(0);
    // 波动放大 10 倍 → 夏普约缩小 10 倍
    expect(s3).toBeLessThan(s2 / 5);
  });

  it('样本不足返回 0', () => {
    expect(computeSharpe([0.01], '5m')).toBe(0);
  });
});

describe('computeMetrics', () => {
  const trades: BacktestTrade[] = [
    { time: 0, side: 'BUY', price: 100, quantity: 1, fee: 0.1, slippageCost: 0, equityAfter: 0, decisionConfidence: 0.7, indicatorScore: 0.5 },
    { time: 1, side: 'SELL', price: 110, quantity: 1, fee: 0.11, slippageCost: 0, equityAfter: 0, decisionConfidence: 0.7, indicatorScore: -0.5 },
    { time: 2, side: 'BUY', price: 110, quantity: 1, fee: 0.11, slippageCost: 0, equityAfter: 0, decisionConfidence: 0.7, indicatorScore: 0.5 },
    { time: 3, side: 'SELL', price: 100, quantity: 1, fee: 0.1, slippageCost: 0, equityAfter: 0, decisionConfidence: 0.7, indicatorScore: -0.5 },
  ];

  it('回合配对：胜率 0.5，卖出所得 − 买入支出', () => {
    const metrics = computeMetrics({
      equityCurve: curve([1000, 1010, 1005]),
      trades,
      initialCapital: 1000,
      interval: '5m',
      firstClose: 100,
      lastClose: 105,
    });
    // 回合1：110−0.11 − (100+0.1) = 9.79（盈利）；回合2：100−0.1 − (110+0.11) = −10.21（亏损）
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.tradeCount).toBe(4);
    // buy&hold：(105−100)/100 = 5%
    expect(metrics.buyHoldReturnPct).toBe(5);
  });

  it('超额收益 = 策略收益 − buy&hold', () => {
    const metrics = computeMetrics({
      equityCurve: curve([1000, 1100, 1050]),
      trades: [],
      initialCapital: 1000,
      interval: '5m',
      firstClose: 100,
      lastClose: 105,
    });
    expect(metrics.totalReturnPct).toBe(5);
    expect(metrics.excessVsBuyHoldPct).toBe(0);
    expect(metrics.maxDrawdownPct).toBeCloseTo(4.55, 1); // 峰值 1100 → 1050
  });
});
