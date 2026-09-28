import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { PerformanceWindow, StrategyPerformance } from '@ai-trader/shared';
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

    return this.fromBaskets(strategyName, symbol, window, rows);
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
      this.fromBaskets(name, symbol, window, list),
    );
  }

  private windowDays(window: PerformanceWindow): number {
    return window === '7d' ? 7 : window === '30d' ? 30 : 0;
  }

  /** 从篮子列表算出全部指标（纯计算，便于单测） */
  private fromBaskets(
    strategyName: string,
    symbol: string,
    window: PerformanceWindow,
    baskets: BasketEntity[],
  ): StrategyPerformance {
    // 一轮的净收益 = 各层已实现盈亏 + 该轮存续期的资金费
    const pnlOf = (b: BasketEntity) => Number(b.realizedPnl) + Number(b.fundingFee);

    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const equityCurve: Array<{ time: string; equity: number }> = [];

    for (const b of baskets) {
      equity += pnlOf(b);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
      if (b.closedAt) {
        equityCurve.push({ time: b.closedAt.toISOString(), equity: Number(equity.toFixed(8)) });
      }
    }

    // 胜率 / 盈亏比
    let grossWin = 0;
    let grossLoss = 0;
    let wins = 0;
    for (const b of baskets) {
      const p = pnlOf(b);
      if (p > 0) {
        grossWin += p;
        wins += 1;
      } else {
        grossLoss += Math.abs(p);
      }
    }
    const winRate = baskets.length > 0 ? wins / baskets.length : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0;

    // 时间跨度 → 年化
    const first = baskets[0]?.closedAt ?? null;
    const last = baskets[baskets.length - 1]?.closedAt ?? null;
    const spanDays = first && last ? Math.max(1, (last.getTime() - first.getTime()) / DAY_MS) : 0;
    const annualizedPnl = spanDays > 0 ? (equity / spanDays) * 365 : 0;

    // 夏普：按「日」聚合收益后算 (均值/标准差)×√365
    const daily = new Map<string, number>();
    for (const b of baskets) {
      if (!b.closedAt) continue;
      const day = b.closedAt.toISOString().slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + pnlOf(b));
    }
    const rets = [...daily.values()];
    const sharpe = this.sharpeRatio(rets);
    const calmar = maxDrawdown > 0 ? annualizedPnl / maxDrawdown : 0;

    return {
      strategyName,
      symbol,
      window,
      closedBaskets: baskets.length,
      totalPnl: Number(equity.toFixed(8)),
      annualizedPnl: Number(annualizedPnl.toFixed(8)),
      maxDrawdown: Number(maxDrawdown.toFixed(8)),
      sharpe: Number(sharpe.toFixed(4)),
      calmar: Number(calmar.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(4)),
      avgLayers:
        baskets.length > 0
          ? Number((baskets.reduce((a, b) => a + b.layerCount, 0) / baskets.length).toFixed(2))
          : 0,
      equityCurve,
      firstClosedAt: first ? first.toISOString() : null,
      lastClosedAt: last ? last.toISOString() : null,
    };
  }

  /** 夏普比率：日收益均值/标准差 × √365；样本不足或零波动时为 0 */
  private sharpeRatio(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
    const std = Math.sqrt(variance);
    if (!(std > 0)) return 0;
    return (mean / std) * Math.sqrt(365);
  }
}
