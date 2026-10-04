import { describe, expect, it } from 'vitest';
import { fundingSlotsInRange } from '../pull/history-pull';

/**
 * P1-A3 数据栈里 fundingSlotsInRange 是唯一可脱库单测的纯函数（其他 puller 依赖 axios +
 * TypeORM DataSource；data-quality 需要真实 repo）。这里锁定「每 8h 一个 UTC 槽」的语义，
 * 防止未来重构（如换成 4h 结算）时静默丢失质检分母。
 */
describe('fundingSlotsInRange', () => {
  const H8 = 8 * 3_600_000;
  it('恰好 1 个 8h 区间给 2 槽（首尾都算）', () => {
    const from = 1_700_000_000_000;
    expect(fundingSlotsInRange(from, from + H8)).toBe(2);
  });

  it('零长度区间给 1 槽（起点即结算槽）', () => {
    const from = 1_700_000_000_000;
    expect(fundingSlotsInRange(from, from)).toBe(1);
  });

  it('反向区间钳到 0（防御性）', () => {
    expect(fundingSlotsInRange(2_000, 1_000)).toBe(0);
  });

  it('7 天 = 21 个 8h 槽（+1 尾槽 = 21）', () => {
    const day = 86_400_000;
    const from = 1_700_000_000_000;
    // floor(7*day / 8h) + 1 = 21 + 1 = 22
    expect(fundingSlotsInRange(from, from + 7 * day)).toBe(22);
  });
});
