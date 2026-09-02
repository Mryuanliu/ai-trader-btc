import type {
  ExchangeCode,
  Environment,
  MarketType,
  OrderSide,
  OrderStatus,
  RunMode,
} from '../types/common';
import type { MarketPulse, Ticker } from '../types/market';
import type { DecisionSummary } from '../types/agent';
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
  recentDecisions: DecisionSummary[];
  news: NewsItemDTO[];
  keywordTrends: KeywordTrend[];
  dataSources: DataSourceStatus[];
  updatedAt: string;
}

export interface RecentOrderItem {
  id: string;
  symbol: string;
  side: OrderSide;
  type: 'MARKET' | 'LIMIT';
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

export interface PlaceOrderRequest {
  exchange: ExchangeCode;
  symbol: string;
  side: OrderSide;
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  /** 实盘下单需要的二次确认 token */
  confirmToken?: string;
  /**
   * 平仓目标 Lot：手动平仓时必须指定要全量平掉的仓位单（UI 列出未完结 Lot 供选择）。
   * 不传时策略链路不允许 SELL/平仓方向（Lot 模型下策略只负责入场）。
   */
  lotId?: string;
  /** 本单止盈止损（hybrid AI 逐单给参数；不传用全局兜底 SL 2%/TP 4%） */
  stopLossPct?: number;
  takeProfitPct?: number;
}

/** 仓位单（Lot）对外视图：订单页分组、持仓页列表共用 */
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
  stopLossPct: number;
  takeProfitPct: number;
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

/** WebSocket 推送事件契约 */
export type RealtimeEvent =
  | { type: 'price'; payload: { symbol: string; price: number; changePercent24h: number; ts: number } }
  | { type: 'order'; payload: RecentOrderItem }
  | { type: 'decision'; payload: DecisionSummary }
  | { type: 'risk'; payload: { level: 'info' | 'warn' | 'error'; message: string; ts: number } }
  | { type: 'news'; payload: NewsItemDTO };

export const WS_EVENT = 'realtime';
