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

// ---------------------------------------------------------------------------
// 合约回测（独立资金模型，现货路径零改动）
// ---------------------------------------------------------------------------

export interface FuturesBacktestConfig {
  symbol: string;
  interval: Timeframe;
  from: number;
  to: number;
  /** 初始保证金（USDT），即钱包余额 */
  initialCapital: number;
  slippageBps: number;
  feeRateBps: number;
  /** 单次开仓占可用保证金的**保证金**比例 0~1（注意与现货的资金比例量纲不同） */
  positionPct: number;
  minConfidence: number;
  strategyName: string;
  strategyParams?: Record<string, unknown>;
  exitRules?: {
    stopLossPct?: number | null;
    takeProfitPct?: number | null;
  };
  warmupBars: number;
  /** 开仓杠杆倍数 1~10 */
  leverage: number;
  /** 数量步进（BTCUSDT 合约为 0.0001） */
  stepSize: number;
  /** 最小名义价值（USDT）；0 表示不校验（单测用） */
  minNotional: number;
  /** 资金费率序列（按 fundingTime 升序）；不传视为零费率 */
  fundingRates?: { fundingTime: number; rate: number }[];
}

export interface FuturesBacktestTrade extends BacktestTrade {
  /** 持仓方向：多头回合=买入开仓，空头回合=卖出开仓 */
  positionSide: 'LONG' | 'SHORT';
  /** 是否为只平仓单（含出场规则与反手信号的第一跳） */
  reduceOnly: boolean;
  /** 本次成交占用的保证金；平仓单为 0 */
  margin: number;
  /** 名义价值 = quantity × price */
  notional: number;
}

export interface FuturesLiquidationEvent {
  time: number;
  /** 强平触发价 */
  price: number;
  /** 强平时损失的保证金（含未实现亏损） */
  loss: number;
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
}

export interface FuturesBacktestReport {
  meta: Omit<BacktestReport['meta'], 'positionPct'> & {
    leverage: number;
    stepSize: number;
    minNotional: number;
    /** 资金费率累计支付（正=净支出，负=净收入） */
    totalFundingPaid: number;
    liquidationCount: number;
  };
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: FuturesBacktestTrade[];
  liquidations: FuturesLiquidationEvent[];
}

/** 杠杆对比表的一行：同一策略同数据下某个杠杆的回测指标 */
export interface FuturesLeverageRow {
  leverage: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  profitFactor: number;
  tradeCount: number;
  liquidationCount: number;
  totalFundingPaid: number;
}

/** compareLeverage=true 时的返回：主报告 + 1x/3x/5x 对比行 */
export interface FuturesLeverageComparison {
  main: FuturesBacktestReport;
  comparison: FuturesLeverageRow[];
}
