import type { BacktestTrade, EquityPoint } from './types';

/** 最大回撤（%）。输入为权益序列，任一点位相对历史峰值的最大跌幅。 */
export function computeMaxDrawdownPct(equityCurve: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return Number(maxDrawdown.toFixed(2));
}

/**
 * 年化夏普比率。输入为逐根 K 线的权益收益率序列（小数），
 * 年化因子由 interval 推导（假设全年无休）。
 */
export function computeSharpe(returns: number[], interval: string): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  // 浮点误差会让「完全恒定」的序列 std 不是精确 0，用极小阈值兜底
  if (std < 1e-12) return 0;

  const barsPerYear = annualizationFactor(interval);
  return Number(((mean / std) * Math.sqrt(barsPerYear)).toFixed(2));
}

/** 全年无休的年化因子（按 interval 推导每年的 K 线数） */
export function annualizationFactor(interval: string): number {
  const barsPerDay = 86_400_000 / intervalMs(interval);
  return Math.round(barsPerDay * 365);
}

function intervalMs(interval: string): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 300_000; // 默认 5m
  const n = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 60_000;
  return n * unitMs;
}

/** 汇总绩效指标。equityCurve 用于回撤，roundTrips 用于胜率与盈亏比 */
export function computeMetrics(params: {
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  initialCapital: number;
  interval: string;
  /** 回放跨度内的第一根收盘价，用于 buy&hold 基准 */
  firstClose: number;
  lastClose: number;
  /**
   * 回合盈亏序列覆盖值；不传时按现货口径（一买一卖配对）推导。
   * 合约回测传 buildFuturesRoundTrips 的结果（空头回合方向相反）。
   */
  roundTripsOverride?: number[];
}): import('./types').BacktestMetrics {
  const { equityCurve, trades, initialCapital, interval, firstClose, lastClose } = params;

  const finalEquity = equityCurve.at(-1)?.equity ?? initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const spanMs = equityCurve.length >= 2
    ? equityCurve.at(-1)!.time - equityCurve[0].time
    : 0;
  const years = spanMs > 0 ? spanMs / (365 * 86_400_000) : 0;
  const annualizedReturnPct =
    years > 0
      ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100
      : totalReturnPct;

  // 逐根权益收益率序列（供夏普）
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) returns.push(equityCurve[i].equity / prev - 1);
  }

  // 一次「完整回合」= 一开一平，用于胜率/盈亏比
  const roundTrips = params.roundTripsOverride ?? buildRoundTrips(trades);
  const wins = roundTrips.filter((pnl) => pnl > 0);
  const losses = roundTrips.filter((pnl) => pnl < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const buyHoldReturnPct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

  return {
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    annualizedReturnPct: Number(annualizedReturnPct.toFixed(2)),
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve),
    sharpeRatio: computeSharpe(returns, interval),
    winRate:
      roundTrips.length > 0 ? Number((wins.length / roundTrips.length).toFixed(4)) : 0,
    profitFactor:
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : 0,
    tradeCount: trades.length,
    buyHoldReturnPct: Number(buyHoldReturnPct.toFixed(2)),
    excessVsBuyHoldPct: Number((totalReturnPct - buyHoldReturnPct).toFixed(2)),
  };
}

/**
 * 合约绩效汇总。
 *
 * 与现货的唯一差异是回合配对：空头回合「先卖开、后买平」，盈亏方向相反，
 * 复用现货的「一买一卖」配对会把空头盈利算成亏损。曲线类指标（收益/回撤/夏普）
 * 与市场无关，直接复用 computeMetrics，只覆盖回合序列。
 */
export function computeFuturesMetrics(params: {
  equityCurve: EquityPoint[];
  trades: import('./types').FuturesBacktestTrade[];
  initialCapital: number;
  interval: string;
  firstClose: number;
  lastClose: number;
}): import('./types').BacktestMetrics {
  return computeMetrics({
    ...params,
    roundTripsOverride: buildFuturesRoundTrips(params.trades),
  });
}

/** 由成交序列配对出完整回合的盈亏（USDT）。开头未平的买入不入胜率统计 */
function buildRoundTrips(trades: BacktestTrade[]): number[] {
  const pnls: number[] = [];
  let open: BacktestTrade | null = null;
  for (const trade of trades) {
    if (trade.side === 'BUY') {
      if (!open) open = trade;
    } else if (open) {
      // 回合盈亏 = 卖出所得 − 买入支出（手续费已各自摊入）
      const buyCost = open.quantity * open.price + open.fee;
      const sellProceeds = trade.quantity * trade.price - trade.fee;
      pnls.push(sellProceeds - buyCost);
      open = null;
    }
  }
  return pnls;
}

/**
 * 合约回合配对：开仓单（reduceOnly=false）与最近的平仓单（reduceOnly=true）配对。
 *
 * 盈亏 = 方向 × (平仓价 − 开仓价) × 数量 − 双边手续费
 * 方向：多头 +1（低买高卖盈利），空头 −1（高卖低买盈利）。
 * 同向加仓不单独配对——成本与均价已在持仓状态里加权，胜率统计以首仓口径为准。
 */
export function buildFuturesRoundTrips(trades: import('./types').FuturesBacktestTrade[]): number[] {
  const pnls: number[] = [];
  let open: import('./types').FuturesBacktestTrade | null = null;
  for (const trade of trades) {
    if (!open) {
      if (!trade.reduceOnly) open = trade;
      continue;
    }
    if (trade.reduceOnly) {
      const dir = open.positionSide === 'SHORT' ? -1 : 1;
      const closedQty = Math.min(open.quantity, trade.quantity);
      const pnl = dir * (trade.price - open.price) * closedQty - (open.fee + trade.fee);
      pnls.push(pnl);
      open = null;
    }
  }
  return pnls;
}
