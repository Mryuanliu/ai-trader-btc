import { describe, expect, it } from 'vitest';
import { computeIndicators, buildSignals, scoreSignals } from '../../indicators/signals';
import { Signal, SignalBias } from '../../types/agent';
import { TrendFollowingStrategy } from '../trend-following';
import { fallbackDecisionOracle, makeContext } from './oracle';
import goldenFixture from './fixtures/btc-5m-500.json';

const strategy = new TrendFollowingStrategy();

function signal(name: string, bias: SignalBias, weight: number): Signal {
  return { name, label: name, value: 0, bias, weight, note: '' };
}

describe('TrendFollowingStrategy.normalizeParams', () => {
  it('非法值回落默认', () => {
    const merged = strategy.normalizeParams({
      entryThreshold: 'abc',
      confidenceBase: NaN,
      confidenceSpan: null,
    });
    expect(merged).toEqual(strategy.defaultParams);
  });

  it('越界值被钳制', () => {
    const merged = strategy.normalizeParams({
      entryThreshold: 5,
      confidenceBase: -1,
      confidenceSpan: 0.9,
    });
    expect(merged).toEqual({ entryThreshold: 1, confidenceBase: 0, confidenceSpan: 0.9 });
  });
});

describe('TrendFollowingStrategy 边界用例（与 oracle 逐值一致）', () => {
  const cases: { label: string; signals: Signal[] }[] = [
    { label: '全中性', signals: ['ma_trend', 'rsi', 'macd', 'bollinger', 'volume', 'mid_term'].map((n) => signal(n, 'neutral', n === 'ma_trend' ? 0.25 : n === 'rsi' || n === 'macd' ? 0.2 : n === 'bollinger' ? 0.15 : 0.1)) },
    { label: '单强信号看多', signals: [signal('ma_trend', 'bullish', 0.25), ...restNeutral()] },
    { label: '单弱信号看多（死区内）', signals: [signal('volume', 'bullish', 0.1), ...restNeutral()] },
    { label: '多空混合 3多2空1中性', signals: [
      signal('ma_trend', 'bullish', 0.25),
      signal('rsi', 'bullish', 0.2),
      signal('macd', 'bullish', 0.2),
      signal('bollinger', 'bearish', 0.15),
      signal('volume', 'bearish', 0.1),
      signal('mid_term', 'neutral', 0.1),
    ] },
  ];

  for (const { label, signals } of cases) {
    it(`${label}：action/confidence 与旧 fallbackDecision 完全一致`, () => {
      const ctx = makeContext({ signals, indicatorScore: scoreSignals(signals) });
      const output = strategy.evaluate(ctx);
      const oracle = fallbackDecisionOracle({ indicatorScore: ctx.indicatorScore });
      expect(output.action).toBe(oracle.action);
      expect(output.confidence).toBe(oracle.confidence);
    });
  }

  it('全中性时 HOLD 且 confidence=0.45', () => {
    const ctx = makeContext({ signals: restNeutral().concat(signal('ma_trend', 'neutral', 0.25)) });
    const output = strategy.evaluate(ctx);
    expect(output.action).toBe('HOLD');
    expect(output.confidence).toBe(0.45);
  });

  it('单一最强信号（score=1.0）时 BUY 且 confidence=0.85', () => {
    // 构造 indicatorScore=1：需要一个权重 1 的信号（绕过 buildSignals 直接注入）
    const ctx = makeContext({ signals: [signal('all', 'bullish', 1)], indicatorScore: 1 });
    const output = strategy.evaluate(ctx);
    expect(output.action).toBe('BUY');
    expect(output.confidence).toBe(0.85);
  });

  it('恰在阈值 score=0.25 触发 BUY', () => {
    const ctx = makeContext({ signals: [signal('all', 'bullish', 0.25)], indicatorScore: 0.25 });
    expect(strategy.evaluate(ctx).action).toBe('BUY');
  });

  it('恰在负阈值 score=-0.25 触发 SELL', () => {
    const ctx = makeContext({ signals: [signal('all', 'bearish', 0.25)], indicatorScore: -0.25 });
    expect(strategy.evaluate(ctx).action).toBe('SELL');
  });

  it('score=0.2499 不触发', () => {
    const ctx = makeContext({ signals: [], indicatorScore: 0.2499 });
    expect(strategy.evaluate(ctx).action).toBe('HOLD');
  });
});

describe('TrendFollowingStrategy golden 对比（真实 K 线滚动窗口 vs oracle）', () => {
  const candles = goldenFixture.candles as Candle[];
  const WINDOW = 200; // 与实盘 HISTORY_LIMIT 对齐

  it('每个滚动窗口的 action/confidence 与旧 fallbackDecision 完全一致', () => {
    let compared = 0;
    let buyCount = 0;
    let sellCount = 0;
    for (let end = WINDOW; end <= candles.length; end++) {
      const window = candles.slice(end - WINDOW, end);
      const ctx = makeContext({ candles: window });
      const output = strategy.evaluate(ctx);
      const oracle = fallbackDecisionOracle({
        indicatorScore: scoreSignals(buildSignals(computeIndicators(window), window)),
      });
      expect(output.action).toBe(oracle.action);
      expect(output.confidence).toBe(oracle.confidence);
      if (output.action === 'BUY') buyCount++;
      if (output.action === 'SELL') sellCount++;
      compared++;
    }
    // 采样有效性：窗口数足够且 BUY/SELL/HOLD 均有出现（避免全部落进同一动作的假一致）
    expect(compared).toBe(301);
    expect(buyCount).toBeGreaterThan(0);
    expect(sellCount).toBeGreaterThan(0);
    expect(compared - buyCount - sellCount).toBeGreaterThan(0);
  });
});

function restNeutral(): Signal[] {
  return [
    signal('rsi', 'neutral', 0.2),
    signal('macd', 'neutral', 0.2),
    signal('bollinger', 'neutral', 0.15),
    signal('volume', 'neutral', 0.1),
    signal('mid_term', 'neutral', 0.1),
  ];
}
