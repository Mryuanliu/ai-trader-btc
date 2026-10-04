import { describe, expect, it } from 'vitest';
import { TIMEFRAME_MS, type BacktestConfig, type EquityPoint } from '@ai-trader/shared';
import { approximateWalkForward } from '../event-driven/research-bridge';

function makeEquityCurve(n: number, start: number = 0, initial: number = 10000): EquityPoint[] {
  const out: EquityPoint[] = [];
  let eq = initial;
  for (let i = 0; i < n; i += 1) {
    // 线性下跌到 60%，然后回升到 95%
    if (i < n * 0.6) eq -= initial * 0.0005;
    else eq += initial * 0.0003;
    out.push({ time: start + i * TIMEFRAME_MS['5m'], equity: eq, drawdownPct: 0 });
  }
  return out;
}

const baseConfig = (): BacktestConfig => ({
  symbol: 'BTCUSDT',
  interval: '5m',
  initialCapital: 10000,
  warmupBars: 20,
  feeRateBps: 4,
  slippageBps: 5,
  fundingPctPer8h: 0.01,
  strategyName: 'test',
  params: {},
});

describe('approximateWalkForward', () => {
  const curve = makeEquityCurve(300, 0);

  it('正常切窗且 segments.length ≥ 1', () => {
    const wf = approximateWalkForward(curve, baseConfig(), {
      trainBars: 100,
      testBars: 50,
      warmupBars: 20,
    });
    expect(wf.segments.length).toBeGreaterThanOrEqual(1);
    expect(wf.oosEquity.length).toBeGreaterThan(0);
    expect(Number.isFinite(wf.aggregateOosSharpe)).toBe(true);
    expect(Number.isFinite(wf.aggregateIsSharpe)).toBe(true);
  });

  it('每段字段完整（index/isTotalReturnPct/oosTotalReturnPct/oosTradeCount）', () => {
    const wf = approximateWalkForward(curve, baseConfig(), {
      trainBars: 80,
      testBars: 40,
      warmupBars: 20,
    });
    for (const seg of wf.segments) {
      expect(typeof seg.index).toBe('number');
      expect(typeof seg.isTotalReturnPct).toBe('number');
      expect(typeof seg.oosTotalReturnPct).toBe('number');
      expect(seg.oosTradeCount).toBe(0);
      expect(seg.trainFrom).toBeLessThan(seg.testFrom);
    }
  });

  it('数据不足时抛错', () => {
    expect(() =>
      approximateWalkForward(curve.slice(0, 30), baseConfig(), {
        trainBars: 100,
        testBars: 50,
        warmupBars: 20,
      }),
    ).toThrow(/不足/);
  });

  it('stepBars 控制窗重叠', () => {
    const wf1 = approximateWalkForward(curve, baseConfig(), {
      trainBars: 100, testBars: 50, warmupBars: 20,
    });
    const wf2 = approximateWalkForward(curve, baseConfig(), {
      trainBars: 100, testBars: 50, stepBars: 25, warmupBars: 20,
    });
    // stepBars 25 < testBars 50 → 更多窗
    expect(wf2.segments.length).toBeGreaterThan(wf1.segments.length);
  });

  it('oosWinRate=0 oosProfitFactor=null（近似无精确 trade 信息）', () => {
    const wf = approximateWalkForward(curve, baseConfig(), {
      trainBars: 60, testBars: 30, warmupBars: 20,
    });
    expect(wf.oosWinRate).toBe(0);
    expect(wf.oosProfitFactor).toBeNull();
  });
});
