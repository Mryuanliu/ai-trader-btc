import { describe, expect, it } from 'vitest';
import { cscvPbo, pboFromReturns } from '../research/pbo';
import { computePlateau } from '../research/plateau';
import { blockBootstrapMaxDD, mulberry32 } from '../research/monte-carlo';
import {
  aggregateDailyCloses,
  classifyDailyRegimes,
  regimeSummary,
  timedReturnsFromEquity,
} from '../research/regime';
import type { Candle } from '@ai-trader/shared';

describe('PBO / CSCV（Bailey-López de Prado 2014）', () => {
  it('无过拟合：真实最优配置在每个子集都最优 → λ 恒正 → PBO=0', () => {
    const S = 12;
    const matrix = [
      Array.from({ length: S }, (_, j) => 3 + j * 0.1),
      Array.from({ length: S }, (_, j) => 2 + j * 0.1),
      Array.from({ length: S }, (_, j) => 1 + j * 0.1),
    ];
    const res = cscvPbo(matrix);
    expect(res.pbo).toBe(0);
    expect(res.nConfigs).toBe(3);
    expect(res.nSubsets).toBe(S);
    expect(res.lambdas.every((l) => l > 0)).toBe(true);
    expect(res.nCombos).toBeGreaterThan(0);
  });

  it('镜像对照（IS 冠军恰为 OOS 输家）→ PBO 显著高于无过拟合场景', () => {
    const S = 12;
    const half = S / 2;
    const upThenDown = [
      ...Array.from({ length: half }, (_, j) => 5 + j),
      ...Array.from({ length: half }, () => 0),
    ];
    const downThenUp = [
      ...Array.from({ length: half }, () => 0),
      ...Array.from({ length: half }, (_, j) => 5 + j),
    ];
    // A 强前半、B 强后半、C 平庸：样本内赢家系统性地在样本外落败
    const overfit = cscvPbo([upThenDown, downThenUp, Array.from({ length: S }, () => 0.1)]);
    expect(overfit.pbo).toBeGreaterThan(0);
    expect(overfit.pbo).toBeLessThanOrEqual(1);
    expect(overfit.lambdas.some((l) => l < 0)).toBe(true);
    // 与上面「无过拟合」场景（PBO=0）对比：过拟合必然产出严格更高的 PBO
    const clean = cscvPbo([
      Array.from({ length: S }, (_, j) => 3 + j * 0.1),
      Array.from({ length: S }, (_, j) => 2 + j * 0.1),
    ]);
    expect(overfit.pbo).toBeGreaterThan(clean.pbo);
  });

  it('配置数 <2 或子集数 <4 抛错', () => {
    expect(() => cscvPbo([[1, 2, 3, 4]])).toThrow(/至少 2 个/);
    expect(() => cscvPbo([[1, 2], [3, 4]])).toThrow(/至少 4 个/);
  });

  it('pboFromReturns 从逐根收益构造性能矩阵并给出 [0,1] 概率', () => {
    // 两个配置：A 全程稳定为正，B 前半段爆发后半段崩塌
    const T = 240;
    const a = Array.from({ length: T }, (_, i) => 0.001 + Math.sin(i / 7) * 0.0002);
    const b = Array.from({ length: T }, (_, i) =>
      i < T / 2 ? 0.004 + Math.sin(i / 5) * 0.0005 : -0.001 + Math.sin(i / 11) * 0.0005,
    );
    const res = pboFromReturns([a, b], { nSubsets: 8 });
    expect(res.pbo).toBeGreaterThanOrEqual(0);
    expect(res.pbo).toBeLessThanOrEqual(1);
    expect(res.subsetBars).toBe(Math.floor(T / 8));
  });
});

describe('参数高原 / 孤峰', () => {
  const grid = { a: [1, 2, 3], b: [10, 20, 30] };
  const combos = [
    { a: 1, b: 10 },
    { a: 1, b: 20 },
    { a: 2, b: 10 },
    { a: 2, b: 20 },
    { a: 3, b: 30 },
  ];

  it('高原：邻域表现相近 → 通过', () => {
    const sharpes = [0.1, 0.11, 0.105, 0.12, 0.02];
    const res = computePlateau({ grid, combos, sharpes, bestIndex: 3 });
    expect(res.neighborCount).toBeGreaterThan(0);
    expect(res.worstNeighborDropPct).toBeLessThanOrEqual(20);
    expect(res.passed).toBe(true);
  });

  it('孤峰：挪一格就崩 → 拒绝', () => {
    const sharpes = [0.01, 0.01, 0.01, 0.5, 0.01];
    const res = computePlateau({ grid, combos, sharpes, bestIndex: 3 });
    // 邻居 {a:1,b:20} 与 {a:2,b:10} 均为 0.01 → 掉幅 98%
    expect(res.worstNeighborDropPct).toBeGreaterThan(20);
    expect(res.passed).toBe(false);
  });

  it('无可比邻居（单点网格）→ 不误判，passed=true 且 neighborCount=0', () => {
    const singleGrid = { a: [2] };
    const res = computePlateau({
      grid: singleGrid,
      combos: [{ a: 2 }],
      sharpes: [0.3],
      bestIndex: 0,
    });
    expect(res.neighborCount).toBe(0);
    expect(res.passed).toBe(true);
  });
});

describe('Monte Carlo block bootstrap', () => {
  it('同种子结果完全可复现（闸门留痕的前提）', () => {
    const rets = Array.from({ length: 200 }, (_, i) => Math.sin(i / 9) * 0.01 + 0.0005);
    const a = blockBootstrapMaxDD(rets, { n: 200, block: 20 });
    const b = blockBootstrapMaxDD(rets, { n: 200, block: 20 });
    expect(a).toEqual(b);
    expect(a.seed).toBe(20240601);
  });

  it('分位单调：p5 ≤ p50 ≤ p95', () => {
    const rets = Array.from({ length: 300 }, (_, i) => Math.sin(i / 5) * 0.02 - 0.0005);
    const r = blockBootstrapMaxDD(rets, { n: 500, block: 30 });
    expect(r.maxDD_p5).toBeLessThanOrEqual(r.maxDD_p50);
    expect(r.maxDD_p50).toBeLessThanOrEqual(r.maxDD_p95);
  });

  it('纯收益上行：回撤恒为 0', () => {
    const rets = Array.from({ length: 100 }, () => 0.002);
    const r = blockBootstrapMaxDD(rets, { n: 50, block: 10 });
    expect(r.maxDD_p95).toBe(0);
  });

  it('mulberry32 输出落在 [0,1)', () => {
    const rnd = mulberry32(12345);
    for (let i = 0; i < 1000; i += 1) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Regime 分层（日线 close vs SMA200 + 30d 实现波动分位）', () => {
  const DAY_MS = 86_400_000;

  /** 前段低波动横盘、后段高波动单边上行（末段 SMA200 必在价格下方） */
  function dailySeries(n: number): { time: number; close: number }[] {
    const out: { time: number; close: number }[] = [];
    let price = 100;
    for (let i = 0; i < n; i += 1) {
      const step = i < 300 ? (i % 2 === 0 ? 0.02 : -0.02) : 3;
      price = Math.max(1, price + step);
      out.push({ time: i * DAY_MS, close: price });
    }
    return out;
  }

  it('高波牛市末段被标注为 bull_highvol', () => {
    const map = classifyDailyRegimes(dailySeries(400), {});
    expect(map.size).toBeGreaterThan(0);
    expect(map.get(399 * DAY_MS)).toBe('bull_highvol');
    // 早期历史不足 → 不标注（杜绝用未来日线判当期 regime）
    expect(map.has(100 * DAY_MS)).toBe(false);
  });

  it('单边下行标 bear_*，且波动分位生效', () => {
    const down: { time: number; close: number }[] = [];
    let price = 100;
    for (let i = 0; i < 400; i += 1) {
      const step = i < 300 ? (i % 2 === 0 ? 0.02 : -0.02) : -3;
      price = Math.max(1, price + step);
      down.push({ time: i * DAY_MS, close: price });
    }
    const map = classifyDailyRegimes(down, {});
    expect(String(map.get(399 * DAY_MS)).startsWith('bear_')).toBe(true);
  });

  it('regimeSummary 按时间对号入座并算各桶 OOS Sharpe', () => {
    const map = classifyDailyRegimes(dailySeries(400), {});
    const lastDay = 399 * DAY_MS;
    const rets = [
      { time: lastDay, ret: 0.001 },
      { time: lastDay, ret: 0.002 },
      { time: lastDay, ret: -0.001 },
      { time: 5 * DAY_MS, ret: 0.01 }, // 未标注 → 不计入
    ];
    const sum = regimeSummary(rets, map, '1h');
    expect(sum.classifiedBars).toBe(3);
    expect(sum.regimesCovered).toBe(1);
    expect(sum.buckets[0].regime).toBe('bull_highvol');
    expect(sum.buckets[0].weightPct).toBe(100);
    expect(Number.isFinite(sum.minRegimeSharpe)).toBe(true);
  });

  it('aggregateDailyCloses 按 UTC 日取最后一根收盘', () => {
    const candles: Candle[] = [];
    for (let d = 0; d < 3; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        const t = d * DAY_MS + h * 3_600_000;
        candles.push({ time: t, open: 1, high: 1, low: 1, close: d * 10 + h, volume: 1 });
      }
    }
    const daily = aggregateDailyCloses(candles);
    expect(daily).toHaveLength(3);
    expect(daily[1].close).toBe(33);
    expect(daily[1].time).toBe(DAY_MS);
  });

  it('timedReturnsFromEquity 跳过首点（无前值）', () => {
    const r = timedReturnsFromEquity([
      { time: 0, equity: 100 },
      { time: 1, equity: 110 },
      { time: 2, equity: 99 },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].ret).toBeCloseTo(0.1, 10);
    expect(r[1].ret).toBeCloseTo(-0.1, 10);
  });
});
