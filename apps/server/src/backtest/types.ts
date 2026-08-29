import type { Timeframe } from '@ai-trader/shared';

export interface BacktestConfig {
  symbol: string;
  interval: Timeframe;
  /** ms 时间戳 */
  from: number;
  /** ms 时间戳 */
  to: number;
  initialCapital: number;
  /** 模拟撮合滑点（bps） */
  slippageBps: number;
  /** 手续费率（bps） */
  feeRateBps: number;
  /** 单次下单使用可用资金比例 0~1（与实盘 execute() 同口径） */
  positionPct: number;
  /** 触发下单的最低置信度 0~1（与实盘 execute() 同口径） */
  minConfidence: number;
  strategyName: string;
  strategyParams?: Record<string, unknown>;
  /**
   * 出场规则（止损/止盈），与实盘 checkExitRules 同口径：
   * 持仓层能力，优先级高于策略信号，触发时全仓卖出
   */
  exitRules?: {
    stopLossPct?: number | null;
    takeProfitPct?: number | null;
  };
  /** 前 N 根只累积指标窗口、不出信号 */
  warmupBars: number;
}

export interface BacktestTrade {
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  fee: number;
  slippageCost: number;
  equityAfter: number;
  decisionConfidence: number;
  indicatorScore: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdownPct: number;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  profitFactor: number;
  tradeCount: number;
  buyHoldReturnPct: number;
  excessVsBuyHoldPct: number;
}

export interface BacktestReport {
  meta: {
    symbol: string;
    interval: Timeframe;
    from: number;
    to: number;
    candleCount: number;
    warmupBars: number;
    initialCapital: number;
    slippageBps: number;
    feeRateBps: number;
    positionPct: number;
    minConfidence: number;
    strategyName: string;
    strategyParams: Record<string, unknown>;
    exitRules: {
      stopLossPct: number | null;
      takeProfitPct: number | null;
    };
    /** 标注成交口径：回测以信号后下一根开盘价成交（无前视、偏保守） */
    fillConvention: 'next-open';
    /** HTTP 报告的 equityCurve 超过上限被等距下采样时为 true */
    downsampled?: boolean;
    /** HTTP 报告的 trades 超过上限只保留最近 N 笔时为 true */
    tradesTruncated?: boolean;
  };
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
}
