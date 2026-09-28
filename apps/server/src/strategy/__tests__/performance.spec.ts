import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import { PerformanceService } from '../performance.service';
import { BasketEntity } from '../../database/entities/basket.entity';

/**
 * 绩效口径测试。
 *
 * 这些断言是 P0 的验收核心：指标一旦算错，排行榜（P3）就会误导决策，
 * 而且错得很隐蔽（看起来是个正常的数字）。所以口径必须用测试钉死。
 */
function basket(over: Partial<BasketEntity> = {}): BasketEntity {
  return {
    id: Math.random().toString(36).slice(2),
    code: 'BK-TEST',
    market: 'futures',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    origin: 'strategy',
    strategyName: 'martingale_grid',
    status: 'CLOSED',
    layerCount: 2,
    totalQuantity: 0.02,
    avgEntryPrice: 84000,
    closedQuantity: 0.02,
    avgExitPrice: 83900,
    feeTotal: 1.5,
    fundingFee: 0,
    realizedPnl: 0,
    returnPct: 0,
    exitReason: 'TAKE_PROFIT',
    openedAt: new Date('2026-09-01T00:00:00Z'),
    closedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as BasketEntity;
}

/**
 * 用 mock 仓储构造服务。
 *
 * mock 必须尊重调用方的 `where.status` 条件——否则「只统计 CLOSED」这条
 * 口径就测不出来（服务把过滤交给数据库，单测里得由 mock 代劳）。
 */
function svcWith(baskets: BasketEntity[]): PerformanceService {
  const repo = {
    find: async (opts?: { where?: { status?: string } }) => {
      const status = opts?.where?.status;
      return status ? baskets.filter((b) => b.status === status) : baskets;
    },
  } as unknown as Repository<BasketEntity>;
  return new PerformanceService(repo);
}

describe('PerformanceService 绩效口径', () => {
  it('只统计已了结的篮子，浮盈（OPEN）不计入收益', async () => {
    // 关键：OPEN 篮子浮盈很大，若被计入会严重虚增排名
    const svc = svcWith([
      basket({ status: 'CLOSED', realizedPnl: 10, layerCount: 2 }),
      basket({ status: 'OPEN', realizedPnl: 9999, layerCount: 3 }),
    ]);

    const r = await svc.compute('martingale_grid', 'BTCUSDT', 'all');
    expect(r.closedBaskets).toBe(1);
    expect(r.totalPnl).toBe(10);
  });

  it('收益 = 已实现盈亏 + 资金费（持仓费用要算进去）', async () => {
    const svc = svcWith([
      basket({ realizedPnl: 20, fundingFee: -3 }), // 赚 20，付了 3 资金费
      basket({ realizedPnl: -5, fundingFee: 1 }), // 亏 5，收到 1 资金费
    ]);

    const r = await svc.compute('martingale_grid', 'BTCUSDT', 'all');
    // 17 + (-4) = 13
    expect(r.totalPnl).toBe(13);
  });

  it('胜率与盈亏比按篮子计算', async () => {
    const svc = svcWith([
      basket({ realizedPnl: 30 }), // 赢
      basket({ realizedPnl: -10 }), // 输
      basket({ realizedPnl: -10 }), // 输
    ]);

    const r = await svc.compute('martingale_grid', 'BTCUSDT', 'all');
    expect(r.closedBaskets).toBe(3);
    expect(r.winRate).toBeCloseTo(1 / 3, 4);
    // 总盈利 30 / 总亏损 20
    expect(r.profitFactor).toBeCloseTo(1.5, 4);
  });

  it('最大回撤 = 净值从峰值到谷底的最大回落', async () => {
    // 净值序列：+50 → 100（峰值）→ 30（回落 70）→ 60（回落 40）
    const svc = svcWith([
      basket({ realizedPnl: 50 }),
      basket({ realizedPnl: 50 }),
      basket({ realizedPnl: -70 }),
      basket({ realizedPnl: 30 }),
    ]);

    const r = await svc.compute('martingale_grid', 'BTCUSDT', 'all');
    expect(r.maxDrawdown).toBe(70);
    expect(r.totalPnl).toBe(60);
  });

  it('净值曲线按了结时间累加，长度与篮子数一致', async () => {
    const svc = svcWith([
      basket({ realizedPnl: 10, closedAt: new Date('2026-09-01T00:00:00Z') }),
      basket({ realizedPnl: -4, closedAt: new Date('2026-09-02T00:00:00Z') }),
    ]);

    const r = await svc.compute('martingale_grid', 'BTCUSDT', 'all');
    expect(r.equityCurve).toHaveLength(2);
    expect(r.equityCurve[0].equity).toBe(10);
    expect(r.equityCurve[1].equity).toBe(6);
  });

  it('全亏时盈亏比为 0，全赢时为 null（无分母）', async () => {
    const allLoss = await svcWith([
      basket({ realizedPnl: -5 }),
      basket({ realizedPnl: -5 }),
    ]).compute('martingale_grid', 'BTCUSDT', 'all');
    expect(allLoss.profitFactor).toBe(0);

    const allWin = await svcWith([
      basket({ realizedPnl: 5 }),
      basket({ realizedPnl: 5 }),
    ]).compute('martingale_grid', 'BTCUSDT', 'all');
    expect(allWin.profitFactor).toBeNull();
  });

  it('无数据时不崩溃，返回零值', async () => {
    const r = await svcWith([]).compute('martingale_grid', 'BTCUSDT', 'all');
    expect(r.closedBaskets).toBe(0);
    expect(r.totalPnl).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.equityCurve).toHaveLength(0);
  });

  it('排行榜按策略名分组', async () => {
    const svc = svcWith([
      basket({ strategyName: 'martingale_grid', realizedPnl: 10 }),
      basket({ strategyName: 'trend_following', realizedPnl: 25 }),
      basket({ strategyName: 'trend_following', realizedPnl: -5 }),
    ]);

    const board = await svc.leaderboard('BTCUSDT', 'all');
    const byName = new Map(board.map((b) => [b.strategyName, b.totalPnl]));
    expect(byName.get('martingale_grid')).toBe(10);
    expect(byName.get('trend_following')).toBe(20);
  });
});
