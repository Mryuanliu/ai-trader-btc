import { describe, expect, it } from 'vitest';
import type { DailyRealizedPnl } from '@ai-trader/shared';
import type { DayIncome } from '../account/income.service';
import { buildPnlBreakdown, mergePnlCalendar } from './overview.service';

const day = (over: Partial<DayIncome> = {}): DayIncome => ({
  date: '2026-09-29',
  realizedPnl: 0,
  realizedCount: 0,
  commission: 0,
  fundingFee: 0,
  other: 0,
  net: 0,
  fills: 0,
  ...over,
});

const lot = (date: string, realizedPnl: number, trades: number): DailyRealizedPnl => ({
  date,
  realizedPnl,
  trades,
});

describe('mergePnlCalendar 盈亏日历统一口径', () => {
  it('该日流水回报 REALIZED_PNL：以 income.net 为权威（费用按成交日归因）', () => {
    const rows = mergePnlCalendar(
      [lot('2026-09-29', -206.62, 31)],
      [day({ realizedCount: 53, realizedPnl: -0.93, commission: -105.61, fundingFee: 0.2, net: -106.34 })],
    );
    expect(rows).toEqual([{ date: '2026-09-29', realizedPnl: -106.34, trades: 31 }]);
  });

  it('demo 常态：流水无 REALIZED_PNL 时回退 Lot 双边费净已实现 + 当日资金费', () => {
    const rows = mergePnlCalendar(
      [lot('2026-09-28', 4.68, 12)],
      [day({ date: '2026-09-28', realizedCount: 0, commission: -100.9, fundingFee: 0.21, net: -100.69 })],
    );
    expect(rows[0].realizedPnl).toBeCloseTo(4.89, 6);
  });

  it('只有流水没有 Lot 的日子也要出现在日历上（如仅收资金费）', () => {
    const rows = mergePnlCalendar([], [day({ date: '2026-09-27', realizedCount: 0, fundingFee: -1.5, net: -1.5 })]);
    expect(rows).toEqual([{ date: '2026-09-27', realizedPnl: -1.5, trades: 0 }]);
  });

  it('笔数回退到流水条数，日期升序输出', () => {
    const rows = mergePnlCalendar(
      [],
      [day({ date: '2026-09-29', realizedCount: 2, net: 5, fills: 7 }), day({ date: '2026-09-28', realizedCount: 2, net: -3, fills: 4 })],
    );
    expect(rows.map((r) => [r.date, r.trades])).toEqual([
      ['2026-09-28', 4],
      ['2026-09-29', 7],
    ]);
  });

  it('两边都为空 → 空日历', () => {
    expect(mergePnlCalendar([], [])).toEqual([]);
  });
});

describe('buildPnlBreakdown 今日盈亏', () => {
  it('已实现直接取日历今日值，浮动为持仓 unrealizedPnl 之和', () => {
    const r = buildPnlBreakdown({
      realizedPnlToday: -106.34,
      fillCount: 62,
      futuresPositions: [
        { unrealizedPnl: -8.85, quantity: 0.01 } as never,
        { unrealizedPnl: 1.35, quantity: -0.02 } as never,
      ],
      incomeCount: 96,
    });
    expect(r.realizedPnlToday).toBeCloseTo(-106.34, 6);
    expect(r.unrealizedPnlToday).toBeCloseTo(-7.5, 6);
    expect(r.pnlToday).toBeCloseTo(-113.84, 6);
    expect(r.hasBaseline).toBe(true);
  });

  it('无成交/持仓/流水时 hasBaseline=false（前端展示 -- 而非 0）', () => {
    const r = buildPnlBreakdown({ realizedPnlToday: 0, fillCount: 0, futuresPositions: [], incomeCount: 0 });
    expect(r.hasBaseline).toBe(false);
    expect(r.pnlToday).toBe(0);
  });

  it('仅有持仓但今日无已实现：pnlToday 等于浮动盈亏', () => {
    const r = buildPnlBreakdown({
      realizedPnlToday: 0,
      fillCount: 0,
      futuresPositions: [{ unrealizedPnl: -8.85, quantity: 0.01 } as never],
      incomeCount: 0,
    });
    expect(r.hasBaseline).toBe(true);
    expect(r.pnlToday).toBeCloseTo(-8.85, 6);
  });
});
