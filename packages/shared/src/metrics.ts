import type { PerformanceWindow, StrategyPerformance } from './dto/api';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 一轮「建仓 → 全部了结」的最小评价单元（对应实盘的「篮子」）。
 *
 * 抽成对 `BasketEntity` 无依赖的纯形状：
 * - 实盘：`performance.service` 把 `BasketEntity[]` 映射成 `PerfRound[]`
 * - 回测：`SimBroker` 直接产出 `PerfRound[]`
 * 两边喂同一个 `computePerformance`，保证「回测口径 === 实盘口径」。
 */
export interface PerfRound {
  /** 该轮各层已实现盈亏之和（已扣双边手续费，USDT） */
  realizedPnl: number;
  /** 该轮存续期累计资金费（USDT，多头付为正） */
  fundingFee: number;
  /** 该轮最后一层了结时间（ms）；未了结为 null */
  closedAt: number | null;
  /** 该轮的层数（建过的仓位单数量） */
  layerCount: number;
}

/**
 * 从「已了结的轮次」算出全部策略绩效指标（纯函数，无 DB 依赖）。
 *
 * 逻辑与迁移前的 `performance.service.fromBaskets` **逐字一致**（口径不变，仅去重复）：
 * - 收益 = 各层已实现盈亏 + 该轮资金费；只统计已了结，浮盈不计入
 * - 年化/夏普基于绝对收益按「日」聚合推算（平台暂不跟踪每策略本金）
 */
export function computePerformance(
  strategyName: string,
  symbol: string,
  window: PerformanceWindow,
  baskets: PerfRound[],
): StrategyPerformance {
  // 一轮的净收益 = 各层已实现盈亏 + 该轮存续期的资金费
  const pnlOf = (b: PerfRound) => b.realizedPnl + b.fundingFee;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve: Array<{ time: string; equity: number }> = [];

  for (const b of baskets) {
    equity += pnlOf(b);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (b.closedAt !== null) {
      equityCurve.push({
        time: new Date(b.closedAt).toISOString(),
        equity: Number(equity.toFixed(8)),
      });
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
  const times = baskets.map((b) => b.closedAt).filter((t): t is number => t !== null);
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  const spanDays = first !== null && last !== null ? Math.max(1, (last - first) / DAY_MS) : 0;
  const annualizedPnl = spanDays > 0 ? (equity / spanDays) * 365 : 0;

  // 夏普：按「日」聚合收益后算 (均值/标准差)×√365
  const daily = new Map<string, number>();
  for (const b of baskets) {
    if (b.closedAt === null) continue;
    const day = new Date(b.closedAt).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + pnlOf(b));
  }
  const rets = [...daily.values()];
  const sharpe = sharpeRatio(rets);
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
    firstClosedAt: first !== null ? new Date(first).toISOString() : null,
    lastClosedAt: last !== null ? new Date(last).toISOString() : null,
  };
}

/** 夏普比率：日收益均值/标准差 × √365；样本不足或零波动时为 0 */
export function sharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
  const std = Math.sqrt(variance);
  if (!(std > 0)) return 0;
  return (mean / std) * Math.sqrt(365);
}
