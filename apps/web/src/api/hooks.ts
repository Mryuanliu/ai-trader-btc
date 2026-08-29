import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { http } from './client';
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

// ------------------------------------------------------------------ 概览
export function useOverview(symbol = 'BTCUSDT', refetchInterval = 15000) {
  return useQuery<OverviewDTO>({
    queryKey: ['overview', symbol],
    queryFn: () => http.get('/overview', { params: { symbol } }),
    refetchInterval,
  });
}

// ------------------------------------------------------------------ 行情
export function useCandles(symbol: string, interval: Timeframe, limit = 300) {
  return useQuery<Candle[]>({
    queryKey: ['candles', symbol, interval, limit],
    queryFn: () => http.get('/market/candles', { params: { symbol, interval, limit } }),
    refetchInterval: 30000,
  });
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
}) {
  return useQuery<PageResult<DecisionSummary>>({
    queryKey: ['decisions', params],
    queryFn: () => http.get('/agent/decisions', { params }),
    refetchInterval: 30000,
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
