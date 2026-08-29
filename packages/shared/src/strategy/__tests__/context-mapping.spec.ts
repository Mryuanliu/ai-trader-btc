import { describe, expect, it } from 'vitest';
import {
  ContextInsight,
  NEUTRAL_CONTEXT_INSIGHT,
  mapInsightToParams,
  normalizeInsight,
  REGIME_CONFIDENCE_FLOOR,
} from '../context-mapping';

const base: ContextInsight = {
  regime: 'trending',
  regimeConfidence: 0.9,
  aggression: 0.5,
  newsSentiment: 0,
  positionView: 'neutral',
  comment: 'ok',
};

describe('mapInsightToParams', () => {
  it('激进度 0.5 时仓位乘数为 1，阈值不偏移（中性默认）', () => {
    const m = mapInsightToParams({ ...base, aggression: 0.5 });
    expect(m.positionMultiplier).toBeCloseTo(1, 10);
    expect(m.entryThreshold).toBeCloseTo(0.85, 6);
  });

  it('仓位乘数 = 0.5 + aggression，且被钳制在 [0.5, 1.5]', () => {
    expect(mapInsightToParams({ ...base, aggression: 0 }).positionMultiplier).toBeCloseTo(0.5, 10);
    expect(mapInsightToParams({ ...base, aggression: 1 }).positionMultiplier).toBeCloseTo(1.5, 10);
  });

  it('激进时下调入场阈值（更易触发），保守时上调', () => {
    const aggressive = mapInsightToParams({ ...base, aggression: 1 });
    const conservative = mapInsightToParams({ ...base, aggression: 0 });
    expect(aggressive.entryThreshold).toBeLessThan(0.85);
    expect(conservative.entryThreshold).toBeGreaterThan(0.85);
  });

  it('极度利空新闻时阈值额外上调（非对称保守）', () => {
    const calm = mapInsightToParams({ ...base, newsSentiment: 0, aggression: 0.5 });
    const bearish = mapInsightToParams({ ...base, newsSentiment: -0.8, aggression: 0.5 });
    expect(bearish.entryThreshold).toBeGreaterThan(calm.entryThreshold!);
  });

  it('利好新闻不改变阈值（只有利空方向做保守偏移）', () => {
    const calm = mapInsightToParams({ ...base, newsSentiment: 0 });
    const bullish = mapInsightToParams({ ...base, newsSentiment: 0.9 });
    expect(bullish.entryThreshold).toBeCloseTo(calm.entryThreshold ?? 0.85, 10);
  });

  it('高置信 volatile 状态上调阈值，低置信不生效', () => {
    const highConf = mapInsightToParams({ ...base, regime: 'volatile', regimeConfidence: 0.9 });
    const lowConf = mapInsightToParams({ ...base, regime: 'volatile', regimeConfidence: 0.3 });
    expect(highConf.entryThreshold).toBeGreaterThan(0.85);
    expect(lowConf.entryThreshold).toBeCloseTo(0.85, 6);
    expect(REGIME_CONFIDENCE_FLOOR).toBe(0.6);
  });

  it('ranging 对 trend_following 小幅上调阈值，对其他策略不生效', () => {
    const tf = mapInsightToParams({ ...base, regime: 'ranging' }, 'trend_following');
    const mr = mapInsightToParams({ ...base, regime: 'ranging' }, 'mean_reversion');
    expect(tf.entryThreshold).toBeGreaterThan(0.85);
    expect(mr.entryThreshold).toBeUndefined();
  });

  it('映射只含生效键，不污染其他策略参数', () => {
    const m = mapInsightToParams(base);
    expect(Object.keys(m).sort()).toEqual(['entryThreshold', 'positionMultiplier']);
  });

  it('非 trend_following 策略只输出仓位乘数', () => {
    const m = mapInsightToParams(base, 'mean_reversion');
    expect(Object.keys(m)).toEqual(['positionMultiplier']);
  });

  it('阈值基于当前参数基准偏移（绝对值），而非覆盖为偏移量', () => {
    const m = mapInsightToParams({ ...base, aggression: 0.5 }, 'trend_following', {
      entryThreshold: 0.9,
    });
    expect(m.entryThreshold).toBeCloseTo(0.9, 6);
  });

  it('阈值被钳制在 [0.3, 0.95] 安全区间', () => {
    const low = mapInsightToParams({ ...base, aggression: 1 }, 'trend_following', {
      entryThreshold: 0.3,
    });
    const high = mapInsightToParams(
      { ...base, aggression: 0, newsSentiment: -1, regime: 'volatile', regimeConfidence: 1 },
      'trend_following',
      { entryThreshold: 0.95 },
    );
    expect(low.entryThreshold).toBeGreaterThanOrEqual(0.3);
    expect(high.entryThreshold).toBeLessThanOrEqual(0.95);
  });
});

describe('normalizeInsight', () => {
  it('合法输入原样通过', () => {
    const out = normalizeInsight({ ...base });
    expect(out.regime).toBe('trending');
    expect(out.regimeConfidence).toBe(0.9);
  });

  it('非法/越界字段被钳制或回落，永不抛错', () => {
    const out = normalizeInsight({
      regime: 'bubble' as never,
      regimeConfidence: 5,
      aggression: -3,
      newsSentiment: 42,
      positionView: 'maybe' as never,
      comment: 'x'.repeat(500),
    });
    expect(out.regime).toBe('trending');
    expect(out.regimeConfidence).toBe(1);
    expect(out.aggression).toBe(0);
    expect(out.newsSentiment).toBe(1);
    expect(out.positionView).toBe('neutral');
    expect(out.comment.length).toBeLessThanOrEqual(80);
  });

  it('完全非法输入回落中性默认', () => {
    expect(normalizeInsight(null)).toEqual(NEUTRAL_CONTEXT_INSIGHT);
    expect(normalizeInsight('garbage' as never)).toEqual(NEUTRAL_CONTEXT_INSIGHT);
  });

  it('中性默认参数映射后仓位乘数为 1、阈值保持基准 0.85', () => {
    const m = mapInsightToParams(NEUTRAL_CONTEXT_INSIGHT);
    expect(m.positionMultiplier).toBeCloseTo(1, 10);
    expect(m.entryThreshold).toBeCloseTo(0.85, 6);
  });
});
