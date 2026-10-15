// score-sizing fixture 单测：分段端点手算对 EA 形状（king-v4-balance L1519–1686）
import { describe, expect, it } from 'vitest';
import {
  trendStrength01,
  directionalStep,
  scoreLotMultiplier,
  basketStartNow,
  sideTargetMult,
  SizingCfg,
} from '../score-sizing';

const cfg: SizingCfg = {
  trendRange: 20,
  trendConfirm: 45,
  trendStrong: 70,
  kStepCounter: 0.083,
  kStepTrend: 0.25,
  basketAmpK: 0.8,
};

describe('trendStrength01（EA L1543）', () => {
  it('≤20 为 0；50 → (50−20)/80=0.375；≥100 封顶 1', () => {
    expect(trendStrength01(20, 20)).toBe(0);
    expect(trendStrength01(-20, 20)).toBe(0);
    expect(trendStrength01(50, 20)).toBeCloseTo(0.375, 10);
    expect(trendStrength01(140, 20)).toBe(1);
  });
});

describe('directionalStep（EA L1519 形状端点）', () => {
  it('震荡域（≤20）→ 基准 s0，与方向无关', () => {
    expect(directionalStep(100, 15, 'LONG', cfg)).toBe(100);
    expect(directionalStep(100, -15, 'SHORT', cfg)).toBe(100);
  });

  it('过渡带上端（45）→ s0×1.25', () => {
    expect(directionalStep(100, -44.999, 'LONG', cfg)).toBeCloseTo(125, 1);
  });

  it('趋势域顺势端点：45 → 1.0×、100 → 0.75×（EA 120→90）', () => {
    expect(directionalStep(100, 45, 'LONG', cfg)).toBeCloseTo(100, 6);
    expect(directionalStep(100, 100, 'LONG', cfg)).toBeCloseTo(75, 6);
  });

  it('趋势域逆势端点：45 → 1.0×、100 → ≈1.083×（EA 140→150）', () => {
    expect(directionalStep(100, 45, 'SHORT', cfg)).toBeCloseTo(100, 6);
    expect(directionalStep(100, 100, 'SHORT', cfg)).toBeCloseTo(108.3, 2);
  });

  it('空方趋势对称：score<0 时 SHORT 是顺势侧', () => {
    expect(directionalStep(100, -100, 'SHORT', cfg)).toBeCloseTo(75, 6);
    expect(directionalStep(100, -100, 'LONG', cfg)).toBeCloseTo(108.3, 2);
  });
});

describe('scoreLotMultiplier（EA L1638 原式）', () => {
  it('震荡=gridMult、强趋势=trendMultMin、中点线性', () => {
    expect(scoreLotMultiplier(10, 1.8, 1.0, cfg)).toBe(1.8);
    expect(scoreLotMultiplier(70, 1.8, 1.0, cfg)).toBe(1.0);
    expect(scoreLotMultiplier(-70, 1.8, 1.0, cfg)).toBe(1.0);
    // 45 → t=(45−20)/(70−20)=0.5 → 1.8−0.8·0.5=1.4
    expect(scoreLotMultiplier(45, 1.8, 1.0, cfg)).toBeCloseTo(1.4, 10);
  });
});

describe('basketStartNow / sideTargetMult（EA L1659/L1674）', () => {
  it('篮子启动线：震荡不变；score=60 → strength=0.5 → ×1.4', () => {
    expect(basketStartNow(0.015, 10, cfg)).toBeCloseTo(0.015, 10);
    expect(basketStartNow(0.015, 60, cfg)).toBeCloseTo(0.015 * (1 + 0.8 * 0.5), 10);
  });

  it('分侧目标：震荡=1；强多(100) LONG=1.6、SHORT=0.72（EA 自然下限）', () => {
    expect(sideTargetMult(10, 'LONG', 20)).toBe(1);
    expect(sideTargetMult(100, 'LONG', 20)).toBeCloseTo(1.6, 10);
    expect(sideTargetMult(100, 'SHORT', 20)).toBeCloseTo(0.72, 10);
    expect(sideTargetMult(-100, 'SHORT', 20)).toBeCloseTo(1.6, 10);
  });
});
