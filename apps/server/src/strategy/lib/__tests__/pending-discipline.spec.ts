// pending-discipline fixture 单测：M3 纪律八项的纯函数语义（EA L4045–4183/L1936/L2139–2177）
import { describe, expect, it } from 'vitest';
import {
  sideExtremes,
  canAddLayer,
  rebalanceEligible,
  shouldTrail,
  applyTriggerFloor,
  marginPrecheck,
  nearFundingWindow,
} from '../pending-discipline';

describe('sideExtremes（EA CollectStats 极值口径）', () => {
  it('持仓与「持仓∪挂单」分别取极；挂单更极端时 any 被拉宽', () => {
    const e = sideExtremes([{ entryPrice: 100_000 }, { entryPrice: 100_400 }], [{ stopPrice: 100_800 }]);
    expect(e).toEqual({ lowestPos: 100_000, highestPos: 100_400, lowestAny: 100_000, highestAny: 100_800 });
  });
  it('空集合 → 全 null', () => {
    expect(sideExtremes([], [])).toEqual({ lowestPos: null, highestPos: null, lowestAny: null, highestAny: null });
  });
});

describe('canAddLayer（EA buy/sell_condition L4071/L4100）', () => {
  const ext = sideExtremes([{ entryPrice: 100_000 }], []);
  it('LONG 逆行恰 2 格 → regression；只走 1 格 → 拒绝（G9 恢复 EA 语义）', () => {
    expect(canAddLayer({ side: 'LONG', price: 99_400, step: 300, ext, rebalance: false })).toBe('regression');
    expect(canAddLayer({ side: 'LONG', price: 99_700, step: 300, ext, rebalance: false })).toBeNull();
  });
  it('SHORT 镜像：上行 2 格 → regression', () => {
    expect(canAddLayer({ side: 'SHORT', price: 100_600, step: 300, ext, rebalance: false })).toBe('regression');
    expect(canAddLayer({ side: 'SHORT', price: 100_300, step: 300, ext, rebalance: false })).toBeNull();
  });
  it('合并极值地板：挂单被跟到 99_300 时，99_400 不满足极值 1 格 → 拒绝', () => {
    const withPend = sideExtremes([{ entryPrice: 100_000 }], [{ stopPrice: 99_300 }]);
    expect(canAddLayer({ side: 'LONG', price: 99_400, step: 300, ext: withPend, rebalance: false })).toBeNull();
    expect(canAddLayer({ side: 'LONG', price: 99_000, step: 300, ext: withPend, rebalance: false })).toBe('regression');
  });
  it('无持仓 → first；再平衡资格且突破本方极值 → rebalance', () => {
    expect(canAddLayer({ side: 'LONG', price: 100_000, step: 300, ext: sideExtremes([], []), rebalance: false })).toBe('first');
    expect(canAddLayer({ side: 'LONG', price: 100_100, step: 300, ext, rebalance: true })).toBe('rebalance');
    expect(canAddLayer({ side: 'LONG', price: 100_100, step: 300, ext, rebalance: false })).toBeNull();
  });
});

describe('rebalanceEligible（EA L4053：ratio>3 且差额>2×baseQty）', () => {
  it('双边都过阈值才资格成立', () => {
    expect(rebalanceEligible({ ourQty: 0.01, oppQty: 0.05, baseQty: 0.01, ratio: 3 })).toBe(true);
    expect(rebalanceEligible({ ourQty: 0.02, oppQty: 0.05, baseQty: 0.01, ratio: 3 })).toBe(false); // 比不够（2.5）
    expect(rebalanceEligible({ ourQty: 0.01, oppQty: 0.05, baseQty: 0.05, ratio: 3 })).toBe(false); // 差额不够 2×baseQty
    expect(rebalanceEligible({ ourQty: 0, oppQty: 0.05, baseQty: 0.01, ratio: 3 })).toBe(false);
  });
});

describe('shouldTrail（EA L4160/L4178 单向跟踪）', () => {
  it('LONG 只向下跟（旧单更高才换）；SHORT 只向上跟', () => {
    expect(shouldTrail('LONG', 100_000, 99_600, 50)).toBe(true);
    expect(shouldTrail('LONG', 100_000, 99_960, 50)).toBe(false); // 不足地板
    expect(shouldTrail('LONG', 100_000, 100_400, 50)).toBe(false); // 向上不跟
    expect(shouldTrail('SHORT', 100_000, 100_060, 50)).toBe(true);
    expect(shouldTrail('SHORT', 100_000, 99_600, 50)).toBe(false);
  });
});

describe('applyTriggerFloor（M3-8 触发价距离地板）', () => {
  it('LONG 抬到 price×(1+d) 之上；SHORT 压到 price×(1−d) 之下；远端不改动', () => {
    expect(applyTriggerFloor('LONG', 100_010, 100_000, 0.0005)).toBe(100_050);
    expect(applyTriggerFloor('LONG', 100_300, 100_000, 0.0005)).toBe(100_300);
    expect(applyTriggerFloor('SHORT', 99_990, 100_000, 0.0005)).toBe(99_950);
  });
});

describe('marginPrecheck（EA CanAffordOrder L1936 双系数）', () => {
  // notional 1000 / 10x → margin 100：需 free>115 且 equity>125
  it('边界严格大于；任一系数不满足即拒', () => {
    expect(marginPrecheck({ availableMargin: 116, equity: 126, notional: 1000, leverage: 10, freeK: 1.15, equityK: 1.25 })).toBe(true);
    expect(marginPrecheck({ availableMargin: 114, equity: 999, notional: 1000, leverage: 10, freeK: 1.15, equityK: 1.25 })).toBe(false);
    expect(marginPrecheck({ availableMargin: 999, equity: 126, notional: 1000, leverage: 10, freeK: 1.15, equityK: 1.25 })).toBe(true);
    expect(marginPrecheck({ availableMargin: 999, equity: 124, notional: 1000, leverage: 10, freeK: 1.15, equityK: 1.25 })).toBe(false);
    expect(marginPrecheck({ availableMargin: 999, equity: 999, notional: 0, leverage: 10, freeK: 1.15, equityK: 1.25 })).toBe(false);
  });
});

describe('nearFundingWindow（8h 结算 ±15min）', () => {
  const boundary = 3 * 8 * 3600_000; // UTC 某日 08:00（epoch 恰对齐）
  it('窗内真、窗外假、边界两侧对称', () => {
    expect(nearFundingWindow(boundary)).toBe(true);
    expect(nearFundingWindow(boundary - 60_000)).toBe(true);
    expect(nearFundingWindow(boundary + 14 * 60_000)).toBe(true);
    expect(nearFundingWindow(boundary + 16 * 60_000)).toBe(false);
    expect(nearFundingWindow(boundary - 16 * 60_000)).toBe(false);
  });
});
