import type {
  ExchangeCode,
  Environment,
  MarketType,
  OrderSide,
  OrderStatus,
  OrderType,
  RunMode,
} from '../types/common';
import type { MarketPulse, Ticker } from '../types/market';
import type { NewsItemDTO, KeywordTrend } from '../types/news';

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface BalanceRow {
  exchange: ExchangeCode;
  environment: Environment;
  asset: string;
  free: number;
  locked: number;
  total: number;
  usdtValue: number;
  updatedAt: string;
}

export interface OverviewDTO {
  ticker: Ticker;
  mode: RunMode;
  environment: Environment;
  agentEnabled: boolean;
  agentRunning: boolean;
  llmAvailable: boolean;
  balances: BalanceRow[];
  totals: {
    usdtValue: number;
    btcAmount: number;
    /**
     * 今日盈亏 = realizedPnlToday + unrealizedPnlToday。
     * 由成交明细直接推导（不依赖余额快照），因此账户有充提或快照缺失时也不会失真。
     */
    pnlToday: number;
    pnlTodayPct: number;
    /** 今日已实现盈亏：今日平仓/售出回合的净盈亏之和（已扣手续费） */
    realizedPnlToday: number;
    /** 当前持仓的浮动盈亏：现货未平仓 + 合约未平仓（合约取自交易所 positionRisk） */
    unrealizedPnlToday: number;
    /** 今日已实现盈亏是否有数据支撑（无成交无持仓时为 false，前端展示 --） */
    hasPnlBaseline: boolean;
    /** 现货未终结订单数 */
    openOrders: number;
    /** 现货今日已成交笔数 */
    filledToday: number;
    /** 合约未终结订单数 */
    futuresOpenOrders: number;
    /** 合约今日已成交笔数 */
    futuresFilledToday: number;
  };
  marketPulse: MarketPulse;
  recentOrders: RecentOrderItem[];
  news: NewsItemDTO[];
  keywordTrends: KeywordTrend[];
  dataSources: DataSourceStatus[];
  updatedAt: string;
}

export interface RecentOrderItem {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  quantity: number;
  status: OrderStatus;
  exchange: ExchangeCode;
  mode: RunMode;
  /** 市场：现货/合约。现货与合约共用订单表，展示时必须区分 */
  market: MarketType;
  /** 成交均价；未成交为 0 */
  filledPrice: number;
  /** 委托金额（USDT） */
  quoteAmount: number;
  /**
   * 本单若是一笔回合的**平仓单**，给出该回合的净盈亏与收益率；
   * 开仓单或未配对到回合的单为 null——开仓本身没有盈亏概念。
   */
  roundTripPnl: number | null;
  roundTripReturnPct: number | null;
  createdAt: string;
}

export interface DataSourceStatus {
  name: string;
  label: string;
  ok: boolean;
  message: string;
  latencyMs?: number;
}

// 注：`PlaceOrderRequest`（现货下单请求）已移除——
// 现货链路早已删除，手动下单统一走 `POST /api/futures/order`。

/**
 * 仓位单（Lot）对外视图。
 *
 * 已移除 `stopLossPct` / `takeProfitPct`：逐层止盈止损随决策引擎一并废弃，
 * 出场由策略负责（马丁网格用篮子追踪止盈），这两个字段只会恒为 0 造成误导。
 */
export interface LotDTO {
  id: string;
  market: 'spot' | 'futures';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  openOrderId: string;
  closeOrderId: string | null;
  quantity: number;
  closedQuantity: number;
  entryPrice: number;
  entryFeeUsdt: number;
  exitPrice: number | null;
  exitFeeUsdt: number | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  exitReason: string | null;
  realizedPnl: number | null;
  returnPct: number | null;
  /** 浮动盈亏（OPEN 时按现价计算，CLOSED 时为 null） */
  unrealizedPnl: number | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ApiError {
  statusCode: number;
  message: string;
  code?: string;
  timestamp: string;
}

/** WebSocket 推送事件契约（decision/risk 事件随决策引擎与风控一并移除） */
export type RealtimeEvent =
  | { type: 'price'; payload: { symbol: string; price: number; changePercent24h: number; ts: number } }
  | { type: 'order'; payload: RecentOrderItem }
  | { type: 'news'; payload: NewsItemDTO };

export const WS_EVENT = 'realtime';

// ---------------------------------------------------------------- 策略托管

/** 策略卡片（策略合集页展示） */
export interface StrategyDescriptor {
  name: string;
  label: string;
  description: string;
  defaultParams: Record<string, unknown>;
  /** 参数 JSON Schema：前端据此动态渲染配置表单 */
  paramSchema: Record<string, unknown>;
}

/** 策略运行状态 */
export interface StrategyRunStatus {
  running: boolean;
  /** 当前运行的策略名 */
  name: string | null;
  label: string | null;
  /** 当前生效参数 */
  params: Record<string, unknown> | null;
  startedAt: string | null;
  lastTickAt: string | null;
  /** 最近一次 tick 的错误（无错误为 null） */
  lastError: string | null;
  /** 策略自定义状态（如网格层数、篮子峰值） */
  state: Record<string, unknown> | null;
  /** 当前未完结仓位单数量 */
  openLotCount: number;
}

/** 阻止策略启动的未完结仓位单（需用户手动平掉） */
export interface BlockingLot {
  id: string;
  direction: string;
  quantity: number;
  entryPrice: number;
  unrealizedPnl: number;
  openedAt: string;
}

/**
 * 启动结果。
 *
 * `ok=false` 时看 `blockingLots`：
 * 有值表示「上一轮策略留下的仓位单还没平」，需用户手动处理；
 * 为空表示其他原因（策略名错误、已有策略在跑），看 `message`。
 */
export interface StrategyStartResult {
  ok: boolean;
  status: StrategyRunStatus;
  blockingLots?: BlockingLot[];
  message: string;
}

/**
 * AI 行情分析结果。
 *
 * 这是平台**唯一**使用大模型的地方：只解读行情、不给交易指令。
 * 买卖决策完全属于策略——AI 的建议不参与任何下单逻辑。
 */
export interface AiMarketAnalysis {
  symbol: string;
  price: number;
  changePercent24h: number;
  /** 本地指标：ATR14（1h） */
  atr: number;
  /** 本地指标：价格相对 30 周期均线的偏离（%） */
  maDeviationPct: number;
  /** AI 判定的市场状态 */
  regime: 'trending' | 'ranging' | 'volatile' | null;
  /** 该判断的置信度 0~1 */
  regimeConfidence: number | null;
  /** 建议激进度 0~1 */
  aggression: number | null;
  /** 新闻情绪 -1~1 */
  newsSentiment: number | null;
  /** 持仓视角 */
  positionView: 'positive' | 'neutral' | 'negative' | null;
  /** AI 点评（一句话） */
  comment: string | null;
  /** 推理模型的思维链（可能为空） */
  reasoning: string | null;
  /** 实际参与分析的模型名 */
  model: string | null;
  /** 分析是否成功；false 时 error 有原因 */
  ok: boolean;
  error: string | null;
  /** 参与分析的新闻条数 */
  newsCount: number;
  generatedAt: string;
}
