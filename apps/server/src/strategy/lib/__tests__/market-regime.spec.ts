// MarketRegime（Brain 内核）fixture 单测：语义锚点为 king-v4-balance.mq5 行号
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import {
  MarketRegime,
  DEFAULT_REGIME_CONFIG,
  computeFrameScore,
  marketStateFromScore,
  resample,
} from '../market-regime';

/** 生成时间升序 K 线：close 由给定函数驱动，h/l 附在 close ±0.5 步内 */
function genCloses(n: number, fn: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = fn(i);
    const prev = i > 0 ? fn(i - 1) : c;
    const step = Math.max(0.001, Math.abs(c - prev));
    out.push({
      time: 1_700_000_000_000 + i * 60_000,
      open: prev,
      high: Math.max(c, prev) + step * 0.5,
      low: Math.min(c, prev) - step * 0.5,
      close: c,
      volume: 1,
    });
  }
  return out;
}

describe('resample（1x → Nx 聚合）', () => {
  it('10 根聚成 5×2 根，OHLC 取组内极值与边界', () => {
    const cs = genCloses(10, (i) => 100 + i);
    const r = resample(cs, 5);
    expect(r).toHaveLength(2);
    expect(r[0].open).toBe(cs[0].open);
    expect(r[0].high).toBe(cs[4].high);
    // 组内第 2 根的 low（下影伸到 99.5）才是区间最低，不是首根
    expect(r[0].low).toBe(cs[1].low);
    expect(r[0].close).toBe(cs[4].close);
    expect(r[1].close).toBe(cs[9].close);
  });

  it('尾部对齐分组：11 根聚 5×2 根，头部余 1 根丢弃（末组必含最新根）', () => {
    expect(resample(genCloses(11, (i) => 100 + i), 5)).toHaveLength(2);
  });

  it('n=1 原样返回', () => {
    const cs = genCloses(3, () => 1);
    expect(resample(cs, 1)).toBe(cs);
  });
});

describe('computeFrameScore（EA ComputeFrameScore L1377）', () => {
  it('数据不足 70 根 → 0 分（EA L1387 同）', () => {
    const r = computeFrameScore(genCloses(60, (i) => 100 + i), 0, DEFAULT_REGIME_CONFIG);
    expect(r.score).toBe(0);
    expect(r.trendiness).toBe(0);
  });

  it('强线性上行 → 接近满分的正分与高趋势度', () => {
    const r = computeFrameScore(genCloses(200, (i) => 100 + i * 0.1), 0, DEFAULT_REGIME_CONFIG);
    expect(r.score).toBeGreaterThan(60);
    expect(r.trendiness).toBeGreaterThan(0.7);
  });

  it('线性下行 → 负分', () => {
    const r = computeFrameScore(genCloses(200, (i) => 120 - i * 0.1), 0, DEFAULT_REGIME_CONFIG);
    expect(r.score).toBeLessThan(-60);
  });

  it('锯齿震荡 → 低趋势度（score 趋 0）', () => {
    const r = computeFrameScore(
      genCloses(200, (i) => 100 + (i % 2 === 0 ? 0 : 2)),
      0,
      DEFAULT_REGIME_CONFIG,
    );
    expect(Math.abs(r.score)).toBeLessThan(30);
    expect(r.trendiness).toBeLessThan(0.4);
  });

  it('per-tf 周期差异生效：同数据 tf0/tf2 评分不同', () => {
    const cs = genCloses(200, (i) => 100 + i * 0.1 + Math.sin(i / 3) * 0.5);
    const a = computeFrameScore(cs, 0, DEFAULT_REGIME_CONFIG);
    const b = computeFrameScore(cs, 2, DEFAULT_REGIME_CONFIG);
    expect(a.score).not.toBe(b.score);
  });
});

describe('marketStateFromScore（EA L1461 七态边界）', () => {
  const cfg = DEFAULT_REGIME_CONFIG;
  it('≤20 震荡、<45 弱、<70 确认、≥70 强（正负对称）', () => {
    expect(marketStateFromScore(20, cfg)).toBe(0);
    expect(marketStateFromScore(20.1, cfg)).toBe(1);
    expect(marketStateFromScore(44.9, cfg)).toBe(1);
    expect(marketStateFromScore(45, cfg)).toBe(2);
    expect(marketStateFromScore(69.9, cfg)).toBe(2);
    expect(marketStateFromScore(70, cfg)).toBe(3);
    expect(marketStateFromScore(-71, cfg)).toBe(-3);
    expect(marketStateFromScore(-46, cfg)).toBe(-2);
    expect(marketStateFromScore(-21, cfg)).toBe(-1);
  });
});

describe('MarketRegime.update（融合/阻尼/平滑/粘滞域机）', () => {
  it('force 首帧直接吸附目标分', () => {
    const reg = new MarketRegime();
    const snap = reg.update(genCloses(1200, (i) => 100 + i * 0.1), true);
    expect(snap.score).toBeCloseTo(snap.scoreTarget, 10);
    expect(snap.state).toBeGreaterThanOrEqual(2);
    expect(snap.dir).toBe(1); // 粘滞域机进入：score ≥ TrendDirEnter 且 chop ≤ gate
  });

  it('锯齿行情：chop 闸门压制方向域（dir 恒 0）', () => {
    const reg = new MarketRegime();
    let snap = reg.update(genCloses(1200, (i) => 100 + (i % 2 === 0 ? 0 : 2)), true);
    snap = reg.update(genCloses(1200, (i) => 100 + (i % 2 === 0 ? 0 : 2)), true);
    expect(snap.chop).toBeGreaterThan(DEFAULT_REGIME_CONFIG.chopGate); // 抖动闸门抬升
    expect(snap.dir).toBe(0);
  });

  it('平滑惯性：由多翻空需要逐帧衰减，单帧翻转最多吸 80%', () => {
    const reg = new MarketRegime();
    const up = genCloses(1200, (i) => 100 + i * 0.1);
    const first = reg.update(up, true);
    expect(first.score).toBeGreaterThan(0);
    // 突然换成等长下行数据：新目标为负，翻转向 adapt=0.80
    const down = genCloses(1200, (i) => 300 - i * 0.1);
    const second = reg.update(down, false);
    const ratio = (second.score - first.score) / (second.scoreTarget - first.score);
    expect(second.scoreTarget).toBeLessThan(0);
    expect(ratio).toBeCloseTo(0.8, 6); // flipping 分支（L1748–1750）
  });

  it('粘滞保持：dir 建立后回落到 Exit 与 Enter 之间不熄灭', () => {
    const reg = new MarketRegime();
    reg.update(genCloses(1200, (i) => 100 + i * 0.1), true);
    expect(reg.current!.dir).toBe(1);
    // 造一段缓慢上涨（趋势度衰减到 Enter 以下、Exit 以上的弱多区）
    const weak = genCloses(1200, (i) => 100 + Math.log(1 + i) * 4);
    let snap = reg.update(weak, false);
    snap = reg.update(weak, false);
    if (Math.abs(snap.score) >= DEFAULT_REGIME_CONFIG.trendDirExit && snap.chop <= DEFAULT_REGIME_CONFIG.chopGate) {
      expect(snap.dir).toBe(1); // 保持，不来回打脸
    }
  });
});
