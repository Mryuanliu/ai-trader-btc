import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import type { IndicatorSnapshot } from '../../types/agent';
import { BreakoutStrategy } from '../breakout';
import { MeanReversionStrategy } from '../mean-reversion';
import type { StrategyContext } from '../types';

const mr = new MeanReversionStrategy();
const bo = new BreakoutStrategy();

function makeContext(overrides: Partial<StrategyContext>): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    timeframe: '5m',
    candles: [],
    indicators: {} as IndicatorSnapshot,
    signals: [],
    indicatorScore: 0,
    ticker: { symbol: 'BTCUSDT', last: 0, bid: 0, ask: 0, time: 0 },
    position: null,
    account: { quoteFree: 10_000, baseFree: 0 },
    params: {},
    ...overrides,
  } as StrategyContext;
}

/** 指标快照：只填两个策略用到的字段 */
function indicators(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    sma5: NaN, sma10: NaN, sma20: NaN, sma60: NaN, ema12: NaN, ema26: NaN,
    rsi14: 50, macd: NaN, macdSignal: NaN, macdHist: NaN,
    bollUpper: 110, bollMid: 100, bollLower: 90,
    atr14: NaN, volumeRatio: 1, lastClose: 100,
    ...over,
  };
}

function bars(count: number, price = 100, volume = 100, t0 = 1_700_000_000_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: t0 + i * 300_000,
    open: price, high: price * 1.001, low: price * 0.999, close: price, volume,
  }));
}

describe('MeanReversionStrategy', () => {
  it('超卖双条件触发 BUY，confidence >= floor', () => {
    const out = mr.evaluate(
      makeContext({ indicators: indicators({ rsi14: 25, lastClose: 89 }) }), // %b = -0.1
    );
    expect(out.action).toBe('BUY');
    expect(out.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('超买双条件触发 SELL', () => {
    const out = mr.evaluate(
      makeContext({ indicators: indicators({ rsi14: 75, lastClose: 111 }) }), // %b > 1
    );
    expect(out.action).toBe('SELL');
    expect(out.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('单条件不触发：RSI 超卖但 %b 中性 → HOLD', () => {
    const out = mr.evaluate(
      makeContext({ indicators: indicators({ rsi14: 25, lastClose: 100 }) }), // %b = 0.5
    );
    expect(out.action).toBe('HOLD');
    expect(out.confidence).toBe(0);
  });

  it('指标样本不足（NaN）→ HOLD，不崩溃', () => {
    const out = mr.evaluate(
      makeContext({ indicators: indicators({ rsi14: NaN }) }),
    );
    expect(out.action).toBe('HOLD');
  });

  it('非法参数回落默认值', () => {
    const p = mr.normalizeParams({ rsiOversold: null, bandPosLow: 'x', extra: 1 });
    expect(p.rsiOversold).toBe(30);
    expect(p.bandPosLow).toBe(0.05);
    expect(p).not.toHaveProperty('extra');
  });
});

describe('BreakoutStrategy', () => {
  it('通道内 → HOLD', () => {
    const out = bo.evaluate(makeContext({ candles: bars(30, 100), indicators: indicators() }));
    expect(out.action).toBe('HOLD');
  });

  it('放量突破通道高点 → BUY，confidence >= floor', () => {
    const candles = bars(30, 100);
    candles.push(
      { time: 1_700_000_000_000 + 30 * 300_000, open: 100, high: 104, low: 99, close: 103, volume: 200 }, // 已闭合：突破高点 100.1
      { time: 1_700_000_000_000 + 31 * 300_000, open: 103, high: 103.5, low: 102, close: 102.5, volume: 100 }, // 未闭合末根（被忽略）
    );
    const out = bo.evaluate(
      makeContext({ candles, indicators: indicators({ volumeRatio: 2 }) }),
    );
    expect(out.action).toBe('BUY');
    expect(out.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('突破但缩量 → HOLD（量能确认）', () => {
    const candles = bars(30, 100);
    candles.push(
      { time: 1_700_000_000_000 + 30 * 300_000, open: 100, high: 104, low: 99, close: 103, volume: 50 },
      { time: 1_700_000_000_000 + 31 * 300_000, open: 103, high: 103.5, low: 102, close: 102.5, volume: 100 },
    );
    const out = bo.evaluate(
      makeContext({ candles, indicators: indicators({ volumeRatio: 0.8 }) }),
    );
    expect(out.action).toBe('HOLD');
  });

  it('放量跌破通道低点 → SELL', () => {
    const candles = bars(30, 100);
    candles.push(
      { time: 1_700_000_000_000 + 30 * 300_000, open: 100, high: 101, low: 96, close: 97, volume: 200 },
      { time: 1_700_000_000_000 + 31 * 300_000, open: 97, high: 98, low: 96.5, close: 97.5, volume: 100 },
    );
    const out = bo.evaluate(
      makeContext({ candles, indicators: indicators({ volumeRatio: 2 }) }),
    );
    expect(out.action).toBe('SELL');
  });

  it('已闭合 K 线不足通道长度 → HOLD', () => {
    const out = bo.evaluate(
      makeContext({ candles: bars(10, 100), indicators: indicators() }),
    );
    expect(out.action).toBe('HOLD');
  });

  it('channelBars 参数舍入与钳制', () => {
    expect(bo.normalizeParams({ channelBars: 20.7 }).channelBars).toBe(21);
    expect(bo.normalizeParams({ channelBars: 1 }).channelBars).toBe(5);
  });
});
