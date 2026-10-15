// M4 出场链纯函数层：对 EA 语义锚点逐项手算钉死
import { describe, expect, it } from 'vitest';
import {
  scoreDomain,
  sideTargetUsdt,
  trendProtectionMinRatio,
  priceRetraced,
  distanceRetraced,
  findReductionPair,
} from '../exit-chain';
import type { LotNetView } from '../exit-chain';

const lv = (o: Partial<LotNetView> & { id: string }): LotNetView => ({
  direction: 'LONG',
  quantity: 0.01,
  netUsdt: 1,
  adverseDist: 0,
  ...o,
});

describe('scoreDomain（EA TryProtectiveCloseBySide L3293/L3313/L3345）', () => {
  it('|score|≤range → range（不看 dir）', () => {
    expect(scoreDomain(15, 1, 20)).toBe('range');
    expect(scoreDomain(-20, -1, 20)).toBe('range');
  });
  it('出震荡域后 dir=0 → neutral；dir≠0 → trend', () => {
    expect(scoreDomain(30, 0, 20)).toBe('neutral');
    expect(scoreDomain(30, 1, 20)).toBe('trend');
    expect(scoreDomain(-30, -1, 20)).toBe('trend');
  });
});

describe('sideTargetUsdt（EA L1674–1686 × 名义折算）', () => {
  it('震荡域倍率=1：1000 名义 × 0.6% = 6U', () => {
    expect(sideTargetUsdt(1000, 0.006, 10, 'LONG', 20)).toBeCloseTo(6, 10);
  });
  it('强趋势(100) 顺势 LONG ×1.6、逆势 SHORT ×0.72（EA 自然下限）', () => {
    expect(sideTargetUsdt(1000, 0.006, 100, 'LONG', 20)).toBeCloseTo(9.6, 10);
    expect(sideTargetUsdt(1000, 0.006, 100, 'SHORT', 20)).toBeCloseTo(4.32, 10);
  });
});

describe('trendProtectionMinRatio（EA MarketTrendProtectionRatio L1490–1496）', () => {
  it('低于确认域 → 0（无趋势保护门槛）', () => {
    expect(trendProtectionMinRatio(30, 45)).toBe(0);
  });
  it('45→0.35、72.5→0.45、100→0.55（0.35+0.2(s−45)/55）', () => {
    expect(trendProtectionMinRatio(45, 45)).toBeCloseTo(0.35, 10);
    expect(trendProtectionMinRatio(72.5, 45)).toBeCloseTo(0.45, 10);
    expect(trendProtectionMinRatio(100, 45)).toBeCloseTo(0.55, 10);
  });
});

describe('priceRetraced / distanceRetraced（EA TrailPriceRetraced L2059）', () => {
  it('比例口径：多头峰 100000 回撤 0.9%（阈值 99100）判触发；空头对称', () => {
    expect(priceRetraced(1, 100_000, 99_000, 0.009)).toBe(true); // 回撤 1% > 0.9%
    expect(priceRetraced(1, 100_000, 99_500, 0.009)).toBe(false); // 回撤 0.5% 未达
    expect(priceRetraced(-1, 100_000, 101_000, 0.009)).toBe(true);
    expect(priceRetraced(-1, 100_000, 100_500, 0.009)).toBe(false);
  });
  it('距离口径（首单 1 格）：边界含等号；参数无效放行', () => {
    expect(distanceRetraced(1, 100_000, 99_700, 300)).toBe(true);
    expect(distanceRetraced(1, 100_000, 99_701, 300)).toBe(false);
    expect(distanceRetraced(-1, 100_000, 100_300, 300)).toBe(true);
    expect(distanceRetraced(1, 0, 99_700, 300)).toBe(false);
    expect(priceRetraced(1, 100_000, 99_000, 0)).toBe(false);
  });
});

describe('findReductionPair（EA L2334–2504，Lot 全平语义）', () => {
  const minNet = 0.01;

  it('基本选对：亏单净<0、盈单净>0、配对净≥minNet', () => {
    const pick = findReductionPair({
      profitLots: [lv({ id: 'p1', netUsdt: 5 })],
      riskLots: [lv({ id: 'r1', netUsdt: -3, direction: 'SHORT' })],
      minNet,
    });
    expect(pick).not.toBeNull();
    expect(pick!.net).toBeCloseTo(2, 10);
    // 配对净不达标拒绝；盈单不盈/亏单不亏也拒绝
    expect(findReductionPair({ profitLots: [lv({ id: 'p1', netUsdt: 2 })], riskLots: [lv({ id: 'r1', netUsdt: -3 })], minNet })).toBeNull();
    expect(findReductionPair({ profitLots: [lv({ id: 'p1', netUsdt: -1 })], riskLots: [lv({ id: 'r1', netUsdt: -3 })], minNet })).toBeNull();
    expect(findReductionPair({ profitLots: [lv({ id: 'p1', netUsdt: 5 })], riskLots: [lv({ id: 'r1', netUsdt: 0.5 })], minNet })).toBeNull();
  });

  it('排序键：不利距离最深 → 亏得多 → 手数差最小 → 配对净更大（EA L2488–2491 + M4-4）', () => {
    const profit = [lv({ id: 'pBig', netUsdt: 5 }), lv({ id: 'pMatch', netUsdt: 4 })]; // 手数同→跳过手数键
    // adverse 主导：距离深的 r2 配任意盈单都优先于 r1
    const r = findReductionPair({
      profitLots: profit,
      riskLots: [lv({ id: 'r1', netUsdt: -3, adverseDist: 100 }), lv({ id: 'r2', netUsdt: -1, adverseDist: 200 })],
      minNet,
    });
    expect(r!.risk.id).toBe('r2');
    expect(r!.profit.id).toBe('pBig'); // 同 r2 下两盈单均可配，net 更大者胜（5+(-1)=4 > 3）
    // 距离相同 → 亏得多优先
    const r2 = findReductionPair({
      profitLots: [lv({ id: 'p1', netUsdt: 5 })],
      riskLots: [lv({ id: 'rA', netUsdt: -1, adverseDist: 100 }), lv({ id: 'rB', netUsdt: -4, adverseDist: 100 })],
      minNet,
    });
    expect(r2!.risk.id).toBe('rB');
    // 距离、亏损都相同 → 手数差最小（全平控敞口漂移）
    const r3 = findReductionPair({
      profitLots: [lv({ id: 'pFar', netUsdt: 5, quantity: 0.1 }), lv({ id: 'pNear', netUsdt: 4.9, quantity: 0.011 })],
      riskLots: [lv({ id: 'r1', netUsdt: -4, adverseDist: 100, quantity: 0.01 })],
      minNet,
    });
    expect(r3!.profit.id).toBe('pNear');
  });

  it('趋势保护（EA L2436–2440）：占比帽 + 保护侧剩余 ≥ 风险侧剩余×minRatio', () => {
    // 占比帽：paired=min(0.01,0.01)=0.01 > cap=max(0.001, 0.01×0.3)=0.003 → 拒
    expect(
      findReductionPair({
        profitLots: [lv({ id: 'p1', netUsdt: 5, quantity: 0.01 })],
        riskLots: [lv({ id: 'r1', netUsdt: -3, quantity: 0.01 })],
        minNet,
        guard: { protectLotsQty: 0.01, riskLotsQty: 0.01, minRatio: 0.35, maxShare: 0.3 },
      }),
    ).toBeNull();
    // 小亏单可对：paired=0.001≤0.003；两侧全平后 afterRisk=0 → 比例闸跳过（EA L2440 同语义）
    const ok = findReductionPair({
      profitLots: [lv({ id: 'p1', netUsdt: 5, quantity: 0.01 })],
      riskLots: [lv({ id: 'rSmall', netUsdt: -3, quantity: 0.001 })],
      minNet,
      guard: { protectLotsQty: 0.01, riskLotsQty: 0.001, minRatio: 0.35, maxShare: 0.3 },
    });
    expect(ok).not.toBeNull();
    const tight = findReductionPair({
      profitLots: [lv({ id: 'p1', netUsdt: 5, quantity: 0.001 })],
      riskLots: [lv({ id: 'r1', netUsdt: -3, quantity: 0.004 })],
      minNet,
      guard: { protectLotsQty: 0.002, riskLotsQty: 0.005, minRatio: 0.4, maxShare: 0.6 },
    });
    // paired=0.001 ≤ cap=max(0.001,0.0012)；afterProtect=0.001 ≥ afterRisk(0.001)×0.4 ✓ → 通过
    expect(tight).not.toBeNull();
    const blocked = findReductionPair({
      profitLots: [lv({ id: 'p1', netUsdt: 5, quantity: 0.001 })],
      riskLots: [lv({ id: 'r1', netUsdt: -3, quantity: 0.004 })],
      minNet,
      guard: { protectLotsQty: 0.0015, riskLotsQty: 0.005, minRatio: 0.6, maxShare: 0.6 },
    });
    // afterProtect≈0.0005 < afterRisk≈0.001 ×0.6=0.0006 → 拒
    expect(blocked).toBeNull();
  });

  it('同 id 不自配（EA L2312 防同一单既盈又亏）', () => {
    expect(
      findReductionPair({ profitLots: [lv({ id: 'x', netUsdt: 5 })], riskLots: [lv({ id: 'x', netUsdt: -3 })], minNet }),
    ).toBeNull();
  });
});
