import type { ExchangeCode, Environment, OrderSide, OrderStatus, RunMode } from '../types/common';
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
    pnlToday: number;
    pnlTodayPct: number;
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
