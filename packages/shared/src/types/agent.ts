import type { Candle, Ticker } from './market';
import type {
  DecisionAction,
  Environment,
  ExchangeCode,
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
  /** 决策链路：llm=AI 决策；strategy=纯策略决策（llm 链路降级到策略时仍记 llm） */
  lane: DecisionLane;
  /** 策略链路（或 llm 链路降级到策略）下实际产出决策的策略名 */
  strategyName?: string | null;
  /** LLM 不可用/解析失败时降级为纯指标 */
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
  /** 决策链路：llm=AI 决策；strategy=纯策略决策（llm 链路降级到策略时仍记 llm） */
  lane: DecisionLane;
  /** 策略链路（或 llm 链路降级到策略）下实际产出决策的策略名 */
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

/** 决策链路：llm=AI 直出决策；strategy=纯策略（零 LLM 参与）；hybrid=AI 提供上下文、策略执行（阶段 5） */
export type DecisionLane = 'llm' | 'strategy' | 'hybrid';

/** 仅 llm 链路生效：LLM 失败后的处理。hold=强制观望；strategy=降级到纯策略；skip=跳过本轮 */
export type LlmFailurePolicy = 'hold' | 'strategy' | 'skip';

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

/** Agent 配置（前后端共用的可编辑部分） */
export interface AgentConfigShape {
  name: string;
  enabled: boolean;
  symbol: string;
  timeframe: Timeframe;
  /** 决策轮询间隔（秒） */
  decisionIntervalSec: number;
  mode: RunMode;
  enabledExchanges: ExchangeCode[];
  /** 单次下单使用可用资金比例 0~1 */
  positionPct: number;
  /** 触发下单的最低置信度 0~1 */
  minConfidence: number;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  /** 风控 */
  maxOrderAmount: number;
  maxDailyOrders: number;
  maxDrawdownPct: number;
  minOrderIntervalSec: number;
  dailyLossLimit: number;
  /**
   * 行情或 LLM 降级时的行为。
   * - hold：强制观望（默认，最安全）
   * - signal：沿用纯指标兜底信号，仍可能下单
   *
   * @deprecated 已废弃，由 llmFailurePolicy 承接「LLM 失败怎么办」的职责；
   * strategy 链路完全忽略本字段。仅保留列以兼容存量数据。
   */
  degradedAction: 'hold' | 'signal';
  /** 决策链路开关（hybrid 将在阶段 5 开放，配置层暂归一为 llm） */
  decisionLane: DecisionLane;
  /** 仅 llm 链路生效：LLM 失败后的行为，承接原 degradedAction 职责 */
  llmFailurePolicy: LlmFailurePolicy;
  /** strategy 链路使用的策略，由 StrategyRegistry 校验 */
  strategyName: StrategyName;
  /** 策略专属参数，由各策略 normalizeParams 校验合并 */
  strategyParams: Record<string, unknown>;
  /**
   * 出场规则（止损/止盈，持仓层能力，两条链路均生效，优先级高于任何开仓信号）。
   * 值为相对持仓均价的小数（0.05 = 5%）；null 表示该项关闭。
   * 默认全关：出场规则会主动平仓，必须显式配置才启用。
   */
  exitRules: ExitRulesShape;
  /** 模拟撮合滑点，单位 bps */
  slippageBps: number;
  /** 手续费率，单位 bps */
  feeRateBps: number;
  /** 单一标的持仓市值占总权益的上限（百分比） */
  maxExposurePct: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfigShape = {
  name: 'BTC 主力 Agent',
  enabled: false,
  symbol: 'BTCUSDT',
  timeframe: '5m',
  decisionIntervalSec: 300,
  mode: 'dry_run',
  enabledExchanges: ['binance'],
  positionPct: 0.1,
  minConfidence: 0.6,
  model: 'deepseek-chat',
  temperature: 0.2,
  maxTokens: 800,
  systemPrompt: [
    '你是一名纪律严明的比特币量化交易员。',
    '你会收到技术指标信号、K 线摘要、账户状态与近期新闻，必须输出严格的 JSON 决策。',
    '原则：只在信号一致且置信度足够时出手；行情矛盾、新闻面重大不确定性时优先观望；',
    '永远把回撤控制放在收益之前。',
  ].join('\n'),
  maxOrderAmount: 2000,
  maxDailyOrders: 20,
  maxDrawdownPct: 10,
  minOrderIntervalSec: 60,
  dailyLossLimit: 500,
  // 降级时强制观望：兜底的纯指标策略未经回测验证，不应接管真实资金
  // @deprecated 由 llmFailurePolicy 承接
  degradedAction: 'hold',
  decisionLane: 'llm',
  llmFailurePolicy: 'hold',
  strategyName: 'trend_following',
  strategyParams: {},
  slippageBps: 5,
  feeRateBps: 10,
  // 单一标的持仓不超过总权益的 60%
  maxExposurePct: 60,
  // 出场规则默认全关：会主动平仓，必须显式配置才启用（计划风险条款）
  exitRules: { stopLossPct: null, takeProfitPct: null },
};

export interface AgentRuntimeState {
  config: AgentConfigShape;
  running: boolean;
  lastRunAt: string | null;
  lastDecisionId: string | null;
  llmAvailable: boolean;
  /**
   * 连续失败退避与熔断状态。
   * `tripped` 为 true 表示已熔断，自动调度暂停，需人工排查下游（LLM / 交易所）。
   */
  health: {
    consecutiveFailures: number;
    nextRetryAt: number;
    tripped: boolean;
  };
  exchanges: {
    code: ExchangeCode;
    label: string;
    enabled: boolean;
    environment: Environment;
    configured: boolean;
    reachable: boolean;
    message?: string;
  }[];
}

export interface OrderDTO {
  id: string;
  exchange: ExchangeCode;
  environment: Environment;
  mode: RunMode;
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
