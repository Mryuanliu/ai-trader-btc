import { describe, it, expect } from 'vitest';
import {
  parseJsonl,
  decomposeGap,
  classifyMiss,
  analyze,
  type EventRow,
  type AnalyzeInput,
} from '../trade-analyzer';

/**
 * 交易档案分析器纯函数（2026-10-17 实测调优回路）。
 * 重点钉住「面板价已达 TP 但未触发」的四段差分解与首因归类——
 * 这是本轮回路的核心可观测产物。
 */

function exitTrace(o: Record<string, unknown>): EventRow {
  return { ts: 1, time: '2026-10-17 10:00:00', inst: 'i', type: 'EXIT_TRACE', ...o };
}

describe('parseJsonl', () => {
  it('逐行解析，跳过空行与坏行', () => {
    const text = '{"ts":1,"type":"A"}\n\nnot-json\n{"ts":2,"type":"B"}\n';
    const rows = parseJsonl(text);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.type)).toEqual(['A', 'B']);
  });
});

describe('decomposeGap · 基差/费用/追踪分解', () => {
  it('基差主导：last 越线 mark 未越线且平仓费很小 → head=basis', () => {
    const ev = exitTrace({
      notExit: 'NO_RULE_HIT',
      net: 50,
      netAtLast: 61,
      netNotional: 8200,
      exitFeeEst: 0.5,
      armed: true,
      rules: {
        tpUsdt: { thr: 60, gap: 10 },
        trail: { gapToArmPct: -0.001, gapToGivebackPct: 0.0005 },
      },
    });
    const d = decomposeGap(ev);
    expect(d.total).toBe(10);
    expect(d.exitFee).toBeCloseTo(0.5, 6);
    // 费后余量 9.5 全归基差（basisDelta=11 >= 9.5）
    expect(d.basis).toBeCloseTo(9.5, 6);
    expect(classifyMiss(ev, d)).toBe('basis');
  });

  it('平仓费主导：last≈mark 且 gap 全由费用构成 → head=exitFee', () => {
    const ev = exitTrace({
      notExit: 'NO_RULE_HIT',
      net: 55.9,
      netAtLast: 60.1,
      netNotional: 8200,
      exitFeeEst: 4.1,
      armed: true,
      rules: { tpUsdt: { thr: 60, gap: 4.1 }, trail: {} },
    });
    const d = decomposeGap(ev);
    expect(d.exitFee).toBeCloseTo(4.1, 6);
    expect(classifyMiss(ev, d)).toBe('exitFee');
  });

  it('在途退避优先于其他归因', () => {
    const ev = exitTrace({
      notExit: 'NO_RULE_HIT',
      net: 62,
      netAtLast: 62,
      netNotional: 8200,
      inflight: 1,
      armed: true,
      rules: { tpUsdt: { thr: 60, gap: -2 }, trail: {} },
    });
    const d = decomposeGap(ev);
    expect(classifyMiss(ev, d)).toBe('backoffOrCooldown');
  });

  it('未 arm 分量按 gapToArmPct×名义 量化', () => {
    const ev = exitTrace({
      notExit: 'NO_RULE_HIT',
      net: 30,
      netAtLast: 61,
      netNotional: 8200,
      armed: false,
      rules: {
        tpUsdt: { thr: 60, gap: 30 },
        trail: { gapToArmPct: 0.004, gapToGivebackPct: 0 },
      },
    });
    const d = decomposeGap(ev);
    expect(d.trailNotArmed).toBeCloseTo(0.004 * 8200, 4);
  });
});

describe('analyze · 未触发审计与 notExit 归堆', () => {
  const baseInput = (events: EventRow[]): AnalyzeInput => ({
    events,
    openLots: [],
    funding: [],
    candles: [],
    failedOrders: [],
    tpThrUsdt: 60,
  });

  it('统计 notExit 计数并检出基差越线事件', () => {
    const events: EventRow[] = [
      exitTrace({
        ts: 100,
        notExit: 'NO_RULE_HIT',
        net: 50,
        netAtLast: 61,
        netNotional: 8200,
        exitFeeEst: 0.5,
        last: 100000,
        armed: true,
        rules: { tpUsdt: { thr: 60, gap: 10 }, trail: { gapToArmPct: -0.001, gapToGivebackPct: 0 } },
      }),
      exitTrace({ ts: 200, notExit: 'INFIGHT_BACKOFF', exit: 'TAKE_PROFIT', inflight: 1, net: 61 }),
    ];
    const r = analyze(baseInput(events));
    expect(r.meta.exitTrace).toBe(2);
    expect(r.notExitCounts.NO_RULE_HIT).toBe(1);
    expect(r.notExitCounts.INFIGHT_BACKOFF).toBe(1);
    expect(r.basisEvents.length).toBe(1);
    expect(r.basisEvents[0].headClass).toBe('basis');
    expect(r.gapAgg.headCounts.basis).toBe(1);
  });

  it('layerCount 直方图与轮次盈亏求和', () => {
    const events: EventRow[] = [
      { ts: 1, time: '', inst: 'i', type: 'BASKET', code: 'B1', layerCount: 2, realizedPnl: 12.5 },
      { ts: 2, time: '', inst: 'i', type: 'BASKET', code: 'B2', layerCount: 1, realizedPnl: -30 },
      {
        ts: 3,
        time: '',
        inst: 'i',
        type: 'LOT_SETTLE',
        basketCode: 'B1',
        direction: 'LONG',
        quantity: 0.1,
        entryPrice: 100000,
        exitPrice: 100100,
        realizedPnl: 6.25,
        exitReason: 'TAKE_PROFIT',
      },
    ];
    const r = analyze(baseInput(events));
    expect(r.layers.max).toBe(2);
    expect(r.layers.histogram[2]).toBe(1);
    expect(r.layers.histogram[1]).toBe(1);
    expect(r.rounds.pnlSum).toBeCloseTo(-17.5, 6);
    expect(r.rounds.tp).toBe(1);
  });
});
