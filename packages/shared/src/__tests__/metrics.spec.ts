import { describe, expect, it } from 'vitest';
import { computePerformance, type PerfRound } from '../metrics';

/**
 * computePerformance 是从 performance.service 抽出的纯函数，
 * 被实盘与回测台共用——口径一旦错，两边一起错且很隐蔽，故用测试钉死关键断言。
 */
const r = (over: Partial<PerfRound> = {}): PerfRound => ({
  realizedPnl: 0,
  fundingFee: 0,
  closedAt: Date.parse('2026-09-01T00:00:00Z'),
  layerCount: 1,
  ...over,
});

describe('computePerformance 口径', () => {
  it('收益 = 已实现 + 资金费；只统计传入的轮次', () => {
    const out = computePerformance('s', 'BTCUSDT', 'all', [
      r({ realizedPnl: 20, fundingFee: -3 }),
      r({ realizedPnl: -5, fundingFee: 1 }),
    ]);
    expect(out.closedBaskets).toBe(2);
    expect(out.totalPnl).toBe(13);
  });

  it('胜率/盈亏比按轮次；全赢 profitFactor=null，全亏=0', () => {
    const mix = computePerformance('s', 'BTCUSDT', 'all', [
      r({ realizedPnl: 30 }),
      r({ realizedPnl: -10 }),
      r({ realizedPnl: -10 }),
    ]);
    expect(mix.winRate).toBeCloseTo(1 / 3, 4);
    expect(mix.profitFactor).toBeCloseTo(1.5, 4);

    const allWin = computePerformance('s', 'BTCUSDT', 'all', [r({ realizedPnl: 5 }), r({ realizedPnl: 5 })]);
    expect(allWin.profitFactor).toBeNull();
    const allLoss = computePerformance('s', 'BTCUSDT', 'all', [r({ realizedPnl: -5 }), r({ realizedPnl: -5 })]);
    expect(allLoss.profitFactor).toBe(0);
  });

  it('最大回撤 = 净值峰值到谷底最大回落', () => {
    const out = computePerformance('s', 'BTCUSDT', 'all', [
      r({ realizedPnl: 50 }),
      r({ realizedPnl: 50 }),
      r({ realizedPnl: -70 }),
      r({ realizedPnl: 30 }),
    ]);
    expect(out.maxDrawdown).toBe(70);
    expect(out.totalPnl).toBe(60);
    expect(out.equityCurve).toHaveLength(4);
    expect(out.equityCurve[2].equity).toBe(30);
  });

  it('空输入不崩溃', () => {
    const out = computePerformance('s', 'BTCUSDT', 'all', []);
    expect(out.closedBaskets).toBe(0);
    expect(out.sharpe).toBe(0);
    expect(out.winRate).toBe(0);
  });
});
