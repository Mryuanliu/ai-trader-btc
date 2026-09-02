import type { Candle, Ticker } from './market';
// 决策诊断类型（type-only 导入，编译后擦除，不会形成运行时循环依赖）
import type { BlockingReasonCode, DecisionDiagnostics } from '../decision-diagnostics';
import type {
  DecisionAction,
  Environment,
  ExchangeCode,
  MarketType,
  OrderSide,
  OrderStatus,
  OrderType,
  RunMode,
  Timeframe,
  OrderSource,
} from './common.js';

export type SignalBias = 'bullish' | 'bearish' | 'neutral';

/** 单个技术指标信号 */
export interface Signal {
  name: string;
  label: string;
  value: number | string;
  bias: SignalBias;
  /** 权重 0~1，用于加权汇总 */
  weight: number;
  note: string;
}

/** 指标快照数值 */
export interface IndicatorSnapshot {
  sma5: number;
  sma10: number;
  sma20: number;
  sma60: number;
  ema12: number;
  ema26: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  bollUpper: number;
  bollMid: number;
  bollLower: number;
  atr14: number;
  /** 最新成交量相对前 20 根均量的倍数 */
  volumeRatio: number;
  lastClose: number;
}

export interface NewsBrief {
  title: string;
  source: string;
  publishedAt: string;
}

/** 决策输入快照（落 JSONB，用于复盘） */
export interface DecisionInputSnapshot {
  symbol: string;
  timeframe: Timeframe;
  ticker: Ticker;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  signals: Signal[];
  /** 指标加权合成的原始倾向 -1 ~ 1 */
  indicatorScore: number;
  news: NewsBrief[];
  account: {
    quoteFree: number;
    baseFree: number;
    mode: RunMode;
    environment: Environment;
    /** 余额来源：交易所实读或虚拟账户推导 */
    source: 'virtual' | 'exchange';
  };
}

export interface DecisionRiskVerdict {
  passed: boolean;
  rejectedBy?: string;
  note?: string;
}

/** 决策链条完整记录 */
export interface DecisionRecord {
  id: string;
  agentId: string;
  symbol: string;
  action: DecisionAction;
  confidence: number;
  /** 接近度 0~1：观望时表达「已达到触发所需的百分比」，解决 confidence 恒为 0 的信息丢失 */
  proximity?: number | null;
  /** 阻塞原因码：为什么没开单/没下单 */
  blockingReason?: BlockingReasonCode | null;
  /** 结构化诊断：信号贡献度、达标差距、触发阈值 */
  diagnostics?: DecisionDiagnostics | null;
  reason: string;
  riskNotes?: string | null;
  inputSnapshot: DecisionInputSnapshot;
  prompt: string;
  llmRaw: string | null;
  /** 推理模型思维链，用于在前端展示完整思考过程 */
  llmReasoning: string | null;
  /** 实际响应的模型名（别名会被替换为真实模型） */
  llmModel: string | null;
  /** token 用量 */
  llmUsage: { prompt: number; completion: number; total: number } | null;
  /** 决策链路：strategy=纯策略；hybrid=AI 上下文 + 策略执行（存量可能有已废弃的 'llm'） */
  lane: DecisionLane;
  /** 实际产出决策的策略名（两条链路都由策略执行） */
  strategyName?: string | null;
  /** 降级标记（如 AI 上下文不可用、出场规则触发等非本体决策） */
  degraded: boolean;
  degradeReason?: string | null;
  risk: DecisionRiskVerdict;
  orderId: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface DecisionSummary {
  id: string;
  symbol: string;
  action: DecisionAction;
  confidence: number;
  reason: string;
  /** 决策链路：strategy=纯策略；hybrid=AI 上下文 + 策略执行（存量可能有已废弃的 'llm'） */
  lane: DecisionLane;
  /** AI 上下文不可用/出场规则触发等非本体决策的降级原因 */
  degradeReason?: string | null;
  /** 实际产出决策的策略名 */
  strategyName?: string | null;
  degraded: boolean;
  riskPassed: boolean;
  riskRejectedBy?: string | null;
  orderStatus?: OrderStatus | null;
  latencyMs: number;
  createdAt: string;
  /** 实际响应的模型名（别名会被替换为真实模型） */
  llmModel?: string | null;
  /** 推理模型思维链，用于在前端展示完整思考过程 */
  llmReasoning?: string | null;
  /** token 用量 */
  llmUsage?: { prompt: number; completion: number; total: number } | null;
}

/**
 * 决策链路。
 * - strategy：纯策略决策，零 LLM 参与
 * - hybrid：AI 仅提供市场上下文（元参数），由策略执行买卖（推荐）
 *
 * 注：原 'llm'（AI 直出 BUY/SELL/HOLD）链路已废弃移除——
 * 不可回测、不可复现、成本高，且失败不可预测。存量数据中仍可能有 lane='llm' 的历史记录。
 */
export type DecisionLane = 'strategy' | 'hybrid';

/** 策略标识。开放字符串：策略是插件式集合，运行时合法性由 StrategyRegistry 校验 */
export type StrategyName = 'trend_following' | (string & {});

/**
 * 出场规则（止损/止盈）。
 * 值为相对持仓均价的小数（0.05 = 5%），null 表示该项关闭；默认全关。
 * 出场属于持仓层能力，两条链路均生效，优先级高于任何开仓信号。
 */
export interface ExitRulesShape {
  /** 止损：亏损达到该比例强制全仓卖出（null 关闭） */
  stopLossPct: number | null;
  /** 止盈：盈利达到该比例强制全仓卖出（null 关闭） */
  takeProfitPct: number | null;
}

export interface OrderDTO {
  id: string;
  exchange: ExchangeCode;
  environment: Environment;
  mode: RunMode;
  /** 市场：现货/合约 */
  market: MarketType;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  quantity: number;
  quoteAmount: number;
  status: OrderStatus;
  filledQuantity: number;
  filledPrice: number;
  exchangeOrderId: string | null;
  source: OrderSource;
  decisionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
