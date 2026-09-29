import type { Timeframe } from './common';
import type { Candle } from './market';
import type { LotDirection } from '../position';
import type { StrategyPerformance } from '../dto/api';
import type { PerfRound } from '../metrics';

/**
 * 回测台类型（前后端共用单一来源）。
 *
 * 原先定义在 `apps/server/src/backtest/backtest.types.ts`，P0+ 下沉到 shared：
 * 后端 runner/service 与前端工作台共用同一套形状，避免类型漂移。
 */

/**
 * 回测台配置。
 *
 * 沿用历史报告的 meta 口径（fillConvention/feeRateBps/slippageBps/warmupBars/initialCapital），
 * 新增防过拟合与资金费近似所需字段。
 */
export interface BacktestConfig {
  symbol: string;
  interval: Timeframe;
  /** 起始毫秒（含）；用 `file` 载入本地数据时可省略 */
  from?: number;
  to?: number;
  /** 初始本金（USDT），仅用于把绝对盈亏换算成收益率/回撤百分比 */
  initialCapital: number;
  /** 预热根数：只用于算指标，期内不做任何开/平仓决策 */
  warmupBars: number;
  /** taker 费率（bps，单边）。默认取 shared FUTURES_TAKER_FEE_RATE 换算 */
  feeRateBps: number;
  /** 滑点（bps，单边，恒对成交方不利） */
  slippageBps: number;
  /**
   * 每 8 小时资金费率（小数，0.0001=0.01%），按持仓名义随时间近似累加。
   * 默认 0（demo 阶段不验证真实资金费收益，仅作可选近似项）。
   */
  fundingPctPer8h: number;
  strategyName: string;
  /** 策略参数（未传则用策略默认值） */
  params?: Record<string, unknown>;
  /** 本地 K 线 JSON 路径（fixture 或缓存文件），给了就跳过联网拉取 */
  file?: string;
  /** 联网拉取时的缓存目录（命中则读缓存） */
  cacheDir?: string;
}

/** 单笔成交明细（进回测报告 trades 数组） */
export interface BacktestTrade {
  time: number;
  side: 'BUY' | 'SELL';
  /** 'OPEN' 开仓 / 'CLOSE' 平仓 */
  kind: 'OPEN' | 'CLOSE';
  price: number;
  quantity: number;
  fee: number;
  slippageCost: number;
  direction: LotDirection;
  reason: string;
  /** 该笔落账后的账户净值 */
  equityAfter: number;
  exitReason?: string;
}

/** 净值曲线点（含浮盈 mark-to-market） */
export interface EquityPoint {
  time: number;
  equity: number;
  drawdownPct: number;
}

/** 回测头部指标（沿用历史报告 metrics 字段名，保证下游读得懂） */
export interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  profitFactor: number | null;
  tradeCount: number;
  buyHoldReturnPct: number;
  excessVsBuyHoldPct: number;
}

export interface CostBreakdown {
  totalFees: number;
  totalSlippage: number;
  totalFunding: number;
}

/** 回测报告：meta / metrics / equityCurve / trades（+ 扩展字段） */
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
    fundingPctPer8h: number;
    strategyName: string;
    strategyParams: Record<string, unknown>;
    /** 成交约定：市价/入场次开成交，STOP 高低价触发 */
    fillConvention: 'next-open';
    generatedAt: string;
  };
  metrics: BacktestMetrics;
  /** 与实盘 performance.service 完全同口径的篮子指标（computePerformance 产出） */
  basketMetrics: StrategyPerformance;
  costBreakdown: CostBreakdown;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
}

/** runner 产出、CLI/服务序列化成报告的中间结果 */
export interface BacktestResult {
  candles: Candle[];
  config: BacktestConfig;
  report: BacktestReport;
  /** 各「建仓→全平」轮次的原始记录（walk-forward 拼接 OOS 篮子时复用） */
  rounds: PerfRound[];
}

// ---------------------------------------------------------------- 防过拟合闸门（P0+）

/** walk-forward 单窗切分：train（IS）与其后紧邻的 test（OOS），时间严格不重叠 */
export interface WalkForwardSegment {
  index: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  isSharpe: number;
  isTotalReturnPct: number;
  oosSharpe: number;
  oosTotalReturnPct: number;
  oosTradeCount: number;
}

/** walk-forward 汇总：拼接各窗 OOS 净值后的权威数字 */
export interface WalkForwardResult {
  trainBars: number;
  testBars: number;
  stepBars: number;
  segments: WalkForwardSegment[];
  /** 拼接后的样本外净值曲线 */
  oosEquity: EquityPoint[];
  /** 全样本内（各窗 IS 平均）夏普，用于对比落差 */
  aggregateIsSharpe: number;
  /** 拼接 OOS 曲线算出的样本外夏普（权威） */
  aggregateOosSharpe: number;
  oosTotalReturnPct: number;
  oosMaxDrawdownPct: number;
  oosWinRate: number;
  oosProfitFactor: number | null;
  oosTradeCount: number;
}

/** CPCV（组合清洗 K 折）各组合的 OOS 夏普分布 */
export interface CpcvResult {
  nCombos: number;
  /** 每个组合的 OOS 夏普（保留原始分布供可视化） */
  oosSharpes: number[];
  mean: number;
  std: number;
  min: number;
  max: number;
  /** 0.05/0.25/0.5/0.75/0.95 分位 */
  quantiles: number[];
}

/**
 * Deflated Sharpe Ratio（Bailey & López de Prado）。
 * 校正「多次试验挑选最优」造成的夏普高估；dsr<0 判定为过拟合。
 */
export interface DeflatedSharpeResult {
  /** 观测（待检验）夏普 */
  obsSharpe: number;
  /** n 次独立试验下期望的最大夏普（门槛） */
  expectedMaxSharpe: number;
  /** 概率积分：DSR = Φ[(obs-E[max])·√(T-1) / √(1-skew·obs+(kurt-1)/4·obs²)]，取值 0~1 */
  dsr: number;
  nTrials: number;
  /** 观测收益的独立样本数（如 OOS 交易日数） */
  T: number;
  skew: number;
  kurtosis: number;
  /** 判定通过：dsr ≥ 阈值（默认 0.95） */
  passed: boolean;
}

/** 稳健性研究报告：walk-forward + 可选 CPCV + DSR 闸门 */
export interface ResearchResult {
  walkForward: WalkForwardResult;
  cpcv?: CpcvResult;
  deflatedSharpe: DeflatedSharpeResult;
  /** 闸门结论：'pass' 可上架候选；'overfit' 判过拟合 */
  verdict: 'pass' | 'overfit';
  note: string;
}

/** 参数扫描单个组合 */
export interface SweepCell {
  params: Record<string, number>;
  metrics: BacktestMetrics;
  /** 可选：对每组也算 DSR（试验数=组合数） */
  dsr?: DeflatedSharpeResult;
}

/** 参数扫描结果 */
export interface SweepResult {
  gridKeys: string[];
  cells: SweepCell[];
  /** 组合总数 */
  combos: number;
  /** 按 Sharpe 排序后的最优组合下标 */
  bestIndex: number;
}

/** lookahead 自检结论 */
export interface LookaheadCheckResult {
  ok: boolean;
  messages: string[];
}

// ---------------------------------------------------------------- 历史留存 DTO

/** 一次回测运行的类型 */
export type BacktestRunKind = 'single' | 'research' | 'sweep';

/** 历史列表项（不含完整报告，仅摘要列） */
export interface BacktestRunSummary {
  id: string;
  createdAt: string;
  label: string | null;
  kind: BacktestRunKind;
  strategyName: string;
  symbol: string;
  interval: Timeframe;
  from: number;
  to: number;
  initialCapital: number;
  totalReturnPct: number | null;
  sharpe: number | null;
  oosSharpe: number | null;
  dsr: number | null;
}
