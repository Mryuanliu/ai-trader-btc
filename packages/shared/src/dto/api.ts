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
import type {
  BasketDirection,
  BasketOrigin,
  BasketStatus,
  LotDirection,
  LotExitReason,
  LotStatus,
} from '../position';
import type { StrategyManifest } from '../strategy-sdk';

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
  /**
   * 当前交易环境的参考价（REST 校验值）。
   *
   * 始终取「当前运行环境」的接口——实盘取 fapi.binance.com、模拟盘取
   * demo-fapi.binance.com，与平台实际行情/交易同源。用于和 WS 实时价做
   * 同源交叉校验，确认行情未断线/滞后；不做跨环境对照。
   */
  referencePrice: number;
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
  /** 近期篮子（一轮建仓 → 了结的整体表现，含各层明细） */
  recentBaskets: BasketSummary[];
  /** 已实现盈亏日历（按自然日聚合已平仓 Lot，供首页盈亏日历图） */
  pnlCalendar: DailyRealizedPnl[];
  news: NewsItemDTO[];
  keywordTrends: KeywordTrend[];
  dataSources: DataSourceStatus[];
  updatedAt: string;
}

/** 某一日的已实现盈亏（仅统计当日平仓/了结的 Lot，已扣双边手续费） */
export interface DailyRealizedPnl {
  /** 自然日，格式 YYYY-MM-DD（Asia/Shanghai 时区） */
  date: string;
  /** 当日已实现盈亏合计（USDT） */
  realizedPnl: number;
  /** 当日了结的 Lot 笔数 */
  trades: number;
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
  /** 所属篮子（一轮建仓 → 了结的周期）；篮子功能上线前的历史数据为 null */
  basketId: string | null;
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
  /**
   * 上架元信息（版本 / 能力声明 / 风险提示）。
   *
   * 前端据此展示「谁写的、需要什么数据、有什么风险」——
   * 平台不做风控，但风险必须被看见。缺失时前端应提示该策略未完善元信息。
   */
  manifest?: StrategyManifest;
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
  /** P2 多实例：当前运行的实例数（单实例恒为 1 或 0） */
  instanceCount?: number;
  /**
   * 当前实例的 OPEN 篮子（含各层明细）。
   *
   * 篮子是「会被一起平掉」的订单分组——类似量化 EA 的魔术号：
   * 一个实例同一交易对同时最多一个 OPEN 篮子，篮子出场时全部层一起了结。
   * 策略详情页据此展示「哪些订单属于一轮、会被一起平掉」。
   */
  baskets?: BasketSummary[];
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

// ---------------------------------------------------------------- 策略绩效

/** 绩效统计窗口 */
export type PerformanceWindow = '7d' | '30d' | 'all';

/**
 * 策略绩效（排行榜与策略详情页的数据源）。
 *
 * **口径要点**：
 * - 只统计**已了结**（CLOSED）的篮子——浮盈不算收益，否则未平仓位会污染排名
 * - 收益 = 各层已实现盈亏（含双边手续费）+ 篮子存续期资金费
 * - 年化/夏普基于**绝对收益**推算（平台暂不跟踪每个策略的本金规模）
 */
export interface StrategyPerformance {
  strategyName: string;
  symbol: string;
  window: PerformanceWindow;
  /** 了结的篮子数 */
  closedBaskets: number;
  /** 累计净收益（USDT） */
  totalPnl: number;
  /** 年化收益（USDT/年，绝对收益口径） */
  annualizedPnl: number;
  /** 最大回撤（USDT，从净值峰值的最大回落） */
  maxDrawdown: number;
  /** 夏普比率（按日收益，年化口径） */
  sharpe: number;
  /** 卡玛比率 = 年化收益 / 最大回撤 */
  calmar: number;
  /** 胜率 0~1（盈利篮子占比） */
  winRate: number;
  /** 盈亏比 = 总盈利 / 总亏损（无亏损时为 null） */
  profitFactor: number | null;
  /** 平均每轮层数 */
  avgLayers: number;
  /** 净值曲线（按篮子了结时间累加） */
  equityCurve: Array<{ time: string; equity: number }>;
  /** 首次/末次了结时间 */
  firstClosedAt: string | null;
  lastClosedAt: string | null;
}

// ---------------------------------------------------------------- 财经日历

/**
 * 财经日历事件（数据源：ForexFactory，交易者最通用的日历）。
 *
 * 覆盖美联储议息（FOMC）、非农（NFP）、CPI 等影响加密市场的宏观事件。
 * BTC 与美元流动性高度相关——高影响事件（加息决议、非农爆冷）往往伴随
 * 加密市场剧烈波动，所以策略与人工复盘都需要知道「下一个大事件何时发生」。
 */
export interface CalendarEventDTO {
  /** 事件名称，如 "FOMC Statement"、"Non-Farm Employment Change"、"CPI m/m" */
  title: string;
  /** 相关货币（USD/EUR/…）；美联储与非农/CPI 恒为 USD */
  country: string;
  /** 事件时间（ISO 8601，含原时区偏移，前端应转为本地时区展示） */
  date: string;
  /** 影响等级：High / Medium / Low / Holiday */
  impact: 'High' | 'Medium' | 'Low' | 'Holiday';
  /** 预期值（讲话/决议类为空字符串） */
  forecast: string;
  /** 前值（无则空字符串） */
  previous: string;
}

// ---------------------------------------------------------------- 篮子

/** 篮子内的一层（一个仓位单） */
export interface BasketLotItem {
  id: string;
  /** 第几层（按开仓时间升序，从 1 开始） */
  layer: number;
  direction: LotDirection;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  /** 该层净盈亏（含双边手续费）；未平仓为 null */
  realizedPnl: number | null;
  returnPct: number | null;
  status: LotStatus;
  exitReason: LotExitReason | null;
  /** 开仓订单号（可跳订单详情） */
  openOrderId: string;
  /** 平仓订单号；未平仓为 null */
  closeOrderId: string | null;
  openedAt: string;
  closedAt: string | null;
}

/**
 * 篮子：一次「建仓 → 全部了结」周期的整体表现。
 *
 * 为什么要按篮子看：马丁网格加层时中间层必然浮亏，
 * 单笔订单的盈亏没有意义——**只有整轮一起算才知道这一轮赚没赚**。
 * 所以总览看板按篮子展示，并给出「整体盈亏」一列。
 */
export interface BasketSummary {
  id: string;
  /** 篮子编号，如 BK-20260923-001 */
  code: string;
  symbol: string;
  /** 篮子方向；多空共存时为 MIXED */
  direction: BasketDirection;
  /** 归属来源：整轮策略 / 整轮手动 / 混合 */
  origin: BasketOrigin;
  status: BasketStatus;
  /** 层数 */
  layerCount: number;
  /** 累计开仓数量 */
  totalQuantity: number;
  /** 开仓均价（数量加权） */
  avgEntryPrice: number;
  closedQuantity: number;
  /** 平仓均价（未平完时为部分口径） */
  avgExitPrice: number | null;
  /** 整体盈亏 = Σ 各层净盈亏（含开仓 + 平仓手续费） */
  realizedPnl: number;
  /**
   * 资金费（持仓费用）：篮子存续期内交易所实际收取/支付之和（可正可负）。
   *
   * 不产生成交，所以只能从交易所资金流水取——做多做空方向不同，
   * 可能是成本也可能是收益。
   */
  fundingFee: number;
  /** 整体收益率 = 整体盈亏 / 开仓名义 */
  returnPct: number | null;
  /** 未平仓数量（= 总数量 − 已平数量） */
  openQuantity: number;
  /**
   * 未平部分的浮动盈亏（按当前价估算）。
   *
   * 篮子未结束时 realizedPnl 恒为 0（还没平仓），
   * 所以「整体盈亏」列对 OPEN 篮子要展示这个值，否则看不出一轮在赚还是在亏。
   */
  unrealizedPnl: number;
  exitReason: LotExitReason | null;
  openedAt: string;
  closedAt: string | null;
  /** 篮子内的各层明细 */
  lots: BasketLotItem[];
}
