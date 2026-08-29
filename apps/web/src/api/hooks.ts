import { useEffect, useMemo, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { http } from './client';
import { useRealtimeStore } from '@/ws/realtime';
import type {
  AgentConfigShape,
  AgentRuntimeState,
  Candle,
  DecisionRecord,
  DecisionSummary,
  Environment,
  KeywordTrend,
  MarketPulse,
  NewsItemDTO,
  OrderDTO,
  OverviewDTO,
  PageResult,
  PlaceOrderRequest,
  Ticker,
  Timeframe,
  ExchangeCode,
} from '@ai-trader/shared';
import { TIMEFRAME_MS } from '@ai-trader/shared';

// ------------------------------------------------------------------ 概览
export function useOverview(symbol = 'BTCUSDT', refetchInterval = 15000) {
  return useQuery<OverviewDTO>({
    queryKey: ['overview', symbol],
    queryFn: () => http.get('/overview', { params: { symbol } }),
    refetchInterval,
  });
}

// ------------------------------------------------------------------ 行情

/**
 * 把实时价格合并进最后一根 K 线，逻辑与服务端 `MarketService.syncDerivedIntervals` 保持一致：
 * 同一周期内只更新 close/high/low，跨周期则追加新 K 线。
 *
 * 这样任意周期（含 1h/4h/1d）都能秒级刷新，无需服务端广播多个周期的 K 线事件。
 */
function mergeLivePrice(
  candles: Candle[],
  interval: Timeframe,
  price: number,
  limit: number,
): Candle[] {
  const last = candles[candles.length - 1];
  if (!last) return candles;

  const step = TIMEFRAME_MS[interval];
  const openTime = Math.floor(Date.now() / step) * step;

  // 缺口超过一个周期说明断连或数据已过期，保持原样，交给重连后的补拉修正
  if (openTime > last.time + step) return candles;

  if (openTime > last.time) {
    const next: Candle = {
      time: openTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    return [...candles, next].slice(-limit);
  }

  // 过期数据（openTime < last.time），忽略
  if (openTime < last.time) return candles;

  return [
    ...candles.slice(0, -1),
    {
      ...last,
      close: price,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
    },
  ];
}

/**
 * K 线：首次 REST 拉全量，之后由 WebSocket 秒级价格事件增量推进，**不再定时轮询**。
 * 断线重连时补拉一次全量，填补断连期间的数据缺口。
 */
export function useCandles(symbol: string, interval: Timeframe, limit = 300) {
  const query = useQuery<Candle[]>({
    queryKey: ['candles', symbol, interval, limit],
    queryFn: () => http.get('/market/candles', { params: { symbol, interval, limit } }),
    refetchInterval: false,
    staleTime: 60_000,
  });

  const price = useRealtimeStore((s) => s.price);
  const connected = useRealtimeStore((s) => s.connected);
  const { refetch } = query;
  const seenConnected = useRef(false);

  // 仅「断线后重连」时补拉全量，修正断连期间增量推进产生的偏差。
  // 首次连接不补拉，避免与挂载时的查询重复请求。
  useEffect(() => {
    if (!connected) return;
    if (seenConnected.current) void refetch();
    seenConnected.current = true;
  }, [connected, refetch]);

  const candles = useMemo(() => {
    const base = query.data ?? [];
    if (base.length === 0) return base;
    if (!price || price.symbol !== symbol || !(price.price > 0)) return base;
    return mergeLivePrice(base, interval, price.price, limit);
  }, [query.data, price, symbol, interval, limit]);

  return { ...query, data: candles };
}

export function useTicker(symbol: string): UseQueryResult<Ticker> {
  return useQuery<Ticker>({
    queryKey: ['ticker', symbol],
    queryFn: () => http.get('/market/ticker', { params: { symbol } }),
    refetchInterval: 10000,
  });
}

export function useMarketPulse(symbol: string): UseQueryResult<MarketPulse> {
  return useQuery<MarketPulse>({
    queryKey: ['pulse', symbol],
    queryFn: () => http.get('/market/pulse', { params: { symbol } }),
    refetchInterval: 30000,
  });
}

// ------------------------------------------------------------------ 订单
export function useOrders(params: {
  page?: number;
  pageSize?: number;
  status?: string;
  source?: string;
}) {
  return useQuery<PageResult<OrderDTO>>({
    queryKey: ['orders', params],
    queryFn: () => http.get('/orders', { params }),
    refetchInterval: 15000,
  });
}

export function useRecentOrders(limit = 10) {
  return useQuery<OrderDTO[]>({
    queryKey: ['orders', 'recent', limit],
    queryFn: () => http.get('/orders/recent', { params: { limit } }),
    refetchInterval: 15000,
  });
}

export function usePlaceOrder() {
  const client = useQueryClient();
  return useMutation<OrderDTO, Error, PlaceOrderRequest>({
    mutationFn: (body) => http.post('/orders', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['orders'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useCancelOrder() {
  const client = useQueryClient();
  return useMutation<OrderDTO, Error, string>({
    mutationFn: (id) => http.post(`/orders/${id}/cancel`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['orders'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

// ------------------------------------------------------------------ Agent
export function useAgentState() {
  return useQuery<AgentRuntimeState>({
    queryKey: ['agent', 'state'],
    queryFn: () => http.get('/agent/config'),
    refetchInterval: 20000,
  });
}

export function useUpdateAgentConfig() {
  const client = useQueryClient();
  return useMutation<AgentConfigShape, Error, Partial<AgentConfigShape>>({
    mutationFn: (patch) => http.patch('/agent/config', patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agent'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useToggleAgent() {
  const client = useQueryClient();
  return useMutation<AgentConfigShape, Error, boolean>({
    mutationFn: (enabled) => http.post('/agent/toggle', { enabled }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agent'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useRunAgent() {
  const client = useQueryClient();
  return useMutation<DecisionSummary, Error, void>({
    mutationFn: () => http.post('/agent/run'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agent'] });
      void client.invalidateQueries({ queryKey: ['orders'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useDecisions(params: {
  page?: number;
  pageSize?: number;
  action?: string;
  executedOnly?: boolean;
  keyword?: string;
  lane?: string;
}) {
  return useQuery<PageResult<DecisionSummary>>({
    queryKey: ['decisions', params],
    queryFn: () => http.get('/agent/decisions', { params }),
    refetchInterval: 30000,
  });
}

/** 决策链路统计（阶段 6）：按链路分组的决策量、降级量与动作分布 */
export interface LaneStats {
  total: number;
  degradedTotal: number;
  lanes: { lane: 'strategy' | 'hybrid'; count: number; degraded: number; buys: number; sells: number; holds: number }[];
}

export function useLaneStats() {
  return useQuery<LaneStats>({
    queryKey: ['decision-lane-stats'],
    queryFn: () => http.get('/agent/decisions/stats'),
    refetchInterval: 60000,
  });
}

// ------------------------------------------------------------------ 回测（阶段 6）
export interface BacktestRequest {
  symbol?: string;
  interval?: string;
  from: string;
  to: string;
  initialCapital?: number;
  slippageBps?: number;
  feeRateBps?: number;
  positionPct?: number;
  minConfidence?: number;
  strategyName?: string;
  strategyParams?: Record<string, unknown>;
  exitRules?: { stopLossPct?: number | null; takeProfitPct?: number | null };
  warmupBars?: number;
  autoBackfill?: boolean;
}

export interface BacktestReportDTO {
  meta: {
    symbol: string;
    interval: string;
    from: number;
    to: number;
    candleCount: number;
    warmupBars: number;
    initialCapital: number;
    strategyName: string;
    strategyParams: Record<string, unknown>;
    exitRules: { stopLossPct: number | null; takeProfitPct: number | null };
    downsampled?: boolean;
  };
  metrics: {
    totalReturnPct: number;
    annualizedReturnPct: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    winRate: number;
    profitFactor: number;
    tradeCount: number;
    buyHoldReturnPct: number;
    excessVsBuyHoldPct: number;
  };
  equityCurve: { time: number; equity: number; drawdownPct: number }[];
  trades: {
    time: number;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    fee: number;
    equityAfter: number;
    decisionConfidence: number;
  }[];
}

export function useBacktestStrategies() {
  return useQuery<
    {
      name: string;
      label: string;
      description: string;
      defaultParams: Record<string, unknown>;
      paramSchema: Record<string, unknown> | null;
    }[]
  >({
    queryKey: ['backtest-strategies'],
    queryFn: () => http.get('/backtest/strategies'),
    staleTime: Infinity,
  });
}

export interface BacktestProgressDTO {
  stage: 'loading' | 'backfill' | 'compute';
  pct: number;
  detail: string;
}

export function useRunBacktest() {
  return useMutation<BacktestReportDTO, Error, BacktestRequest>({
    mutationFn: (req) => http.post('/backtest/run', req),
  });
}

/** 回测执行进度：仅在回测 pending 时轮询（后端计算分块让出事件循环，轮询才有响应） */
export function useBacktestProgress(enabled: boolean) {
  return useQuery<BacktestProgressDTO | null>({
    queryKey: ['backtest-progress'],
    queryFn: () => http.get('/backtest/progress'),
    refetchInterval: 300,
    enabled,
  });
}

export function useDecisionDetail(id: string | null) {
  return useQuery<DecisionRecord>({
    queryKey: ['decision', id],
    queryFn: () => http.get(`/agent/decisions/${id}`),
    enabled: Boolean(id),
  });
}

// ------------------------------------------------------------------ 新闻
export function useNews(params: { page?: number; pageSize?: number; source?: string; keyword?: string }) {
  return useQuery<PageResult<NewsItemDTO>>({
    queryKey: ['news', params],
    queryFn: () => http.get('/news', { params }),
    refetchInterval: 60000,
  });
}

export function useNewsSources() {
  return useQuery<{ source: string; count: number }[]>({
    queryKey: ['news', 'sources'],
    queryFn: () => http.get('/news/sources'),
    refetchInterval: 120000,
  });
}

export function useKeywordTrends(limit = 12) {
  return useQuery<KeywordTrend[]>({
    queryKey: ['news', 'keywords', limit],
    queryFn: () => http.get('/news/keywords', { params: { limit } }),
    refetchInterval: 120000,
  });
}

export function useRefreshNews() {
  const client = useQueryClient();
  return useMutation<{ added: number; simulated: boolean }, Error, void>({
    mutationFn: () => http.post('/news/refresh'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['news'] });
    },
  });
}

// ------------------------------------------------------------------ 风控
export function useRiskEvents(params: { page?: number; pageSize?: number }) {
  return useQuery<
    PageResult<{
      id: string;
      type: string;
      level: string;
      message: string;
      symbol: string;
      createdAt: string;
    }>
  >({
    queryKey: ['risk', 'events', params],
    queryFn: () => http.get('/risk/events', { params }),
    refetchInterval: 30000,
  });
}

// ------------------------------------------------------------------ 交易所账户
export interface ExchangeAccountView {
  id: string;
  exchange: ExchangeCode;
  label: string;
  environment: Environment;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  message: string;
  apiKeyMasked: string;
  hasPassphrase: boolean;
}

export function useAccounts() {
  return useQuery<ExchangeAccountView[]>({
    queryKey: ['accounts'],
    queryFn: () => http.get('/accounts'),
    retry: false,
  });
}

export function useUpdateAccount() {
  const client = useQueryClient();
  return useMutation<
    ExchangeAccountView,
    Error,
    { exchange: ExchangeCode; patch: Record<string, unknown> }
  >({
    mutationFn: ({ exchange, patch }) => http.patch(`/accounts/${exchange}`, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useTestAccount() {
  const client = useQueryClient();
  return useMutation<{ ok: boolean; message: string; latencyMs?: number }, Error, ExchangeCode>({
    mutationFn: (exchange) => http.post(`/accounts/${exchange}/test`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

// ------------------------------------------------------------------ 鉴权
export function useLogin() {
  return useMutation<
    { accessToken: string; user: { username: string } },
    Error,
    { username: string; password: string }
  >({
    mutationFn: (body) => http.post('/auth/login', body),
  });
}
