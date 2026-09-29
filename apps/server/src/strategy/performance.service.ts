import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { PerformanceWindow, StrategyPerformance } from '@ai-trader/shared';
import { computePerformance, type PerfRound } from '@ai-trader/shared';
import { BasketEntity } from '../database/entities/basket.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 策略绩效服务（P0）。
 *
 * 为什么以「篮子」为计算单元：
 * 马丁类策略加层时中间层必然浮亏，单笔订单盈亏毫无意义；
 * 篮子是「一轮建仓 → 全部了结」的完整周期，才是能评价的最小单元。
 *
 * **口径纪律（很重要）**：
 * 只统计 `status = CLOSED` 的篮子，即**已实现**收益。
 * 浮盈一律不计入——否则一个浮亏的策略会因为「暂时浮盈」排到榜首，
 * 排名会完全失真。
 */
@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    @InjectRepository(BasketEntity)
    private readonly basketRepo: Repository<BasketEntity>,
  ) {}

  /** 单个策略在指定窗口内的绩效 */
  async compute(
    strategyName: string,
    symbol: string,
    window: PerformanceWindow = 'all',
  ): Promise<StrategyPerformance> {
    const since = window === 'all' ? null : Date.now() - this.windowDays(window) * DAY_MS;

    const baskets = await this.basketRepo.find({
      where: { status: 'CLOSED', strategyName, symbol },
      order: { closedAt: 'ASC' },
    });

    const rows = since
      ? baskets.filter((b) => b.closedAt && b.closedAt.getTime() >= since)
      : baskets;

    return computePerformance(strategyName, symbol, window, toRounds(rows));
  }

  /** 全部策略的绩效（排行榜用） */
  async leaderboard(
    symbol: string,
    window: PerformanceWindow = '30d',
  ): Promise<StrategyPerformance[]> {
    const since = window === 'all' ? null : Date.now() - this.windowDays(window) * DAY_MS;
    const all = await this.basketRepo.find({
      where: { status: 'CLOSED', symbol },
      order: { closedAt: 'ASC' },
    });
    const rows = since
      ? all.filter((b) => b.closedAt && b.closedAt.getTime() >= since)
      : all;

    const byStrategy = new Map<string, BasketEntity[]>();
    for (const b of rows) {
      const key = b.strategyName || 'manual';
      const arr = byStrategy.get(key) ?? [];
      arr.push(b);
      byStrategy.set(key, arr);
    }

    return [...byStrategy.entries()].map(([name, list]) =>
      computePerformance(name, symbol, window, toRounds(list)),
    );
  }

  private windowDays(window: PerformanceWindow): number {
    return window === '7d' ? 7 : window === '30d' ? 30 : 0;
  }
}

/** BasketEntity → PerfRound：closedAt 转 ms（未了结为 null） */
function toRounds(baskets: BasketEntity[]): PerfRound[] {
  return baskets.map((b) => ({
    realizedPnl: Number(b.realizedPnl),
    fundingFee: Number(b.fundingFee),
    closedAt: b.closedAt ? b.closedAt.getTime() : null,
    layerCount: b.layerCount,
  }));
}
