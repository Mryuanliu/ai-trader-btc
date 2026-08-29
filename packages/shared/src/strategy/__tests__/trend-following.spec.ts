import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSignals, computeIndicators, scoreSignals } from '../../indicators/signals';
import type { Candle } from '../../types/market';
import { TrendFollowingStrategy } from '../trend-following';
import type { StrategyContext } from '../types';

const strategy = new TrendFollowingStrategy();

function makeContext(overrides: Partial<StrategyContext> & { indicatorScore: number }): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    timeframe: '5m',
    candles: [],
    indicators: {} as StrategyContext['indicators'],
    signals: [],
    ticker: { symbol: 'BTCUSDT', last: 0, bid: 0, ask: 0, time: 0 },
    position: null,
    account: { quoteFree: 10_000, baseFree: 0 },
    params: {},
    ...overrides,
  } as StrategyContext;
}

describe('TrendFollowingStrategy · 阶段3缺陷修复', () => {
  it('默认 entryThreshold 为 0.85（回测校准值）', () => {
    expect(strategy.defaultParams.entryThreshold).toBe(0.85);
  });

  it('缺陷①：score 恰在阈值时触发 BUY，confidence = confidenceFloor，无死区', () => {
    const out = strategy.evaluate(makeContext({ indicatorScore: 0.25, params: { entryThreshold: 0.25 } }));
    expect(out.action).toBe('BUY');
    expect(out.confidence).toBe(0.6);
  });

  it('缺陷①：默认阈值下 score=0.25 不再触发（修复了低阈值过度交易）', () => {
    expect(strategy.evaluate(makeContext({ indicatorScore: 0.25 })).action).toBe('HOLD');
  });

  it('缺陷①：阈值以下 HOLD，confidence 为 0', () => {
    const out = strategy.evaluate(makeContext({ indicatorScore: 0.2499, params: { entryThreshold: 0.25 } }));
    expect(out.action).toBe('HOLD');
    expect(out.confidence).toBe(0);
  });

  it('缺陷①：confidence 随 |score| 单调递增，封顶 1.0', () => {
    const p = { entryThreshold: 0.25 };
    const c1 = strategy.evaluate(makeContext({ indicatorScore: 0.25, params: p })).confidence;
    const c2 = strategy.evaluate(makeContext({ indicatorScore: 0.6, params: p })).confidence;
    const c3 = strategy.evaluate(makeContext({ indicatorScore: 2, params: p })).confidence;
    expect(c2).toBeGreaterThan(c1);
    expect(c3).toBe(1);
    expect(c3).toBeGreaterThan(c2);
  });

  it('缺陷①：SELL 对称——-0.25 触发 SELL 且 confidence 同 BUY(0.25)', () => {
    const p = { entryThreshold: 0.25 };
    const sell = strategy.evaluate(makeContext({ indicatorScore: -0.25, params: p }));
    const buy = strategy.evaluate(makeContext({ indicatorScore: 0.25, params: p }));
    expect(sell.action).toBe('SELL');
    expect(sell.confidence).toBe(buy.confidence);
  });

  it('缺陷②：单信号看多不再给出满分 score', () => {
    const signal = (bias: 'bullish' | 'bearish' | 'neutral', weight: number) => ({
      name: 'x', label: 'x', value: 'x', bias, weight, note: '',
    });
    // 仅一个权重 0.25 的信号看多：旧实现 score=1.0，新实现=0.25/1.0
    const score = scoreSignals([signal('bullish', 0.25), signal('neutral', 0.75)]);
    expect(score).toBeCloseTo(0.25, 4);
  });

  it('缺陷②：全部信号同向时 score = ±1', () => {
    const signals = [0.25, 0.2, 0.2, 0.15, 0.1, 0.1].map((weight) => ({
      name: 'x', label: 'x', value: 'x', bias: 'bullish' as const, weight, note: '',
    }));
    expect(scoreSignals(signals)).toBe(1);
  });

  it('缺陷③：量能统计排除未闭合的末根 K 线', () => {
    // 末根（未闭合）成交量接近 0，前 21 根均为 100 —— 旧实现 volumeRatio≈0，新实现应为 1
    const candles: Candle[] = Array.from({ length: 22 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 300_000,
      open: 100, high: 101, low: 99, close: 100,
      volume: i === 21 ? 0.001 : 100,
    }));
    const snapshot = computeIndicators(candles);
    expect(snapshot.volumeRatio).toBeCloseTo(1, 6);
  });

  it('缺陷③：量能方向取已闭合 K 线——末根暴跌但已闭合 K 线上涨时量能为 bullish', () => {
    // 前 20 根平稳（量 100），第 21 根（最后已闭合）上涨且放量，第 22 根（未闭合）暴跌缩量
    const candles: Candle[] = Array.from({ length: 22 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 300_000,
      open: 100, high: 101, low: 99,
      close: i === 21 ? 50 : 100, // 末根未闭合暴跌
      volume: i === 21 ? 200 : i === 20 ? 200 : 100,
    }));
    const snapshot = computeIndicators(candles);
    const signals = buildSignals(snapshot, candles);
    const volume = signals.find((s) => s.name === 'volume');
    expect(volume?.bias).toBe('bullish');
  });
});

describe('TrendFollowingStrategy · 参数归一化', () => {
  it('非法参数回落默认值（null/undefined/空串/非数值）', () => {
    const p = strategy.normalizeParams({ entryThreshold: null, confidenceFloor: '', extra: 'x' });
    expect(p.entryThreshold).toBe(0.85);
    expect(p.confidenceFloor).toBe(0.6);
    expect(p).not.toHaveProperty('extra');
  });

  it('越界参数被钳制', () => {
    const p = strategy.normalizeParams({ entryThreshold: -1, confidenceFloor: 2 });
    expect(p.entryThreshold).toBe(0);
    expect(p.confidenceFloor).toBe(1);
  });

  it('entryThreshold=0 时任何非零 score 都触发（边界保护：threshold=1 不除零）', () => {
    const out = strategy.evaluate(makeContext({ indicatorScore: 0.01, params: { entryThreshold: 0 } }));
    expect(out.action).toBe('BUY');
    expect(() =>
      strategy.evaluate(makeContext({ indicatorScore: 1, params: { entryThreshold: 1 } })),
    ).not.toThrow();
  });
});

describe('TrendFollowingStrategy · 真实行情 golden 抽样', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/btc-5m-500.json'), 'utf8'),
  ) as Candle[];

  it('500 根真实 K 线上 action 只能是 BUY/SELL/HOLD，confidence 在 [0,1]', () => {
    const WINDOW = 200;
    for (let i = WINDOW; i < fixture.length; i++) {
      const window = fixture.slice(i - WINDOW, i + 1);
      const indicators = computeIndicators(window);
      const signals = buildSignals(indicators, window);
      const score = scoreSignals(signals);
      const out = strategy.evaluate(makeContext({ indicatorScore: score }));
      expect(['BUY', 'SELL', 'HOLD']).toContain(out.action);
      expect(out.confidence).toBeGreaterThanOrEqual(0);
      expect(out.confidence).toBeLessThanOrEqual(1);
      if (out.action !== 'HOLD') {
        // 缺陷①的核心不变式：触发即通过 minConfidence=0.6
        expect(out.confidence).toBeGreaterThanOrEqual(0.6);
      }
    }
  });
});
