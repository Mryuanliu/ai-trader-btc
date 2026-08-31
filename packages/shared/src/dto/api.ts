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
    /** 今日已实现盈亏是否有数据支撑（无成交时为 false，前端展示 --） */
    hasPnlBaseline: boolean;
    openOrders: number;
    filledToday: number;
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
