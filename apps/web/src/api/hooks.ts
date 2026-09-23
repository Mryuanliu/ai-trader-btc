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
  AiMarketAnalysis,
  Candle,
  Environment,
  FuturesAgentConfigShape,
  KeywordTrend,
  LotDTO,
  MarketPulse,
  NewsItemDTO,
  OrderDTO,
  OverviewDTO,
  PageResult,
  StrategyDescriptor,
  StrategyRunStatus,
  StrategyStartResult,
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
  /** 市场：现货/合约共用订单表，必须隔离查询 */
  market?: 'spot' | 'futures';
}) {
  return useQuery<PageResult<OrderDTO>>({
    queryKey: ['orders', params],
    queryFn: () => http.get('/orders', { params }),
    refetchInterval: 15000,
  });
}

/** 未完结仓位单列表：交易面板「选择要平的 Lot」、持仓页列表共用 */
export function useOpenLots(params: { market?: 'spot' | 'futures'; symbol?: string }) {
  return useQuery<LotDTO[]>({
    queryKey: ['lots', 'open', params],
    queryFn: () => http.get('/lots', { params: { ...params, status: 'open' } }),
    enabled: Boolean(params.market),
    refetchInterval: 15000,
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

// ------------------------------------------------------------------ 合约（独立链路）
export interface FuturesPositionDTO {
  symbol: string;
  market: 'futures';
  quantity: number;
  positionSide: 'LONG' | 'SHORT' | null;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  isolatedMargin: number;
  unrealizedPnl: number;
  notional: number;
  liquidationDistancePct: number | null;
}


export function useFuturesPositions() {
  return useQuery<FuturesPositionDTO[]>({
    queryKey: ['futures', 'positions'],
    queryFn: () => http.get('/futures/positions'),
    refetchInterval: 5000,
  });
}

export function useFuturesMargin() {
  return useQuery<{ available: number }>({
    queryKey: ['futures', 'margin'],
    queryFn: () => http.get('/futures/margin'),
    refetchInterval: 5000,
  });
}

export function useFuturesConfig() {
  return useQuery<FuturesAgentConfigShape>({
    queryKey: ['futures', 'config'],
    queryFn: () => http.get('/futures/config'),
    refetchInterval: 10000,
  });
}

export function useUpdateFuturesConfig() {
  const client = useQueryClient();
  return useMutation<FuturesAgentConfigShape, Error, Record<string, unknown>>({
    mutationFn: (patch) => http.patch('/futures/config', patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['futures', 'config'] });
    },
  });
}

/** 合约手动下单入参（action 为策略语义，lotId 传了就平该 Lot） */
export interface FuturesPlaceOrderInput {
  action: 'BUY' | 'SELL';
  symbol?: string;
  lotId?: string;
  type?: 'MARKET' | 'LIMIT';
  price?: number;
  quantity?: number;
  leverage?: number;
}

/** 合约手动下单：手动平指定 Lot（带 lotId）或开仓（不带 lotId） */
export function useFuturesPlaceOrder() {
  const client = useQueryClient();
  return useMutation<
    { order: { id: string; status: string } | null; leverage: number; risk: { passed: boolean; note?: string } },
    Error,
    FuturesPlaceOrderInput
  >({
    mutationFn: (body) => http.post('/futures/order', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['futures', 'positions'] });
      void client.invalidateQueries({ queryKey: ['futures', 'orders'] });
      void client.invalidateQueries({ queryKey: ['lots'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

// useRunFuturesEngine（手动触发一次决策）与 useFuturesHealth（熔断健康度）
// 已移除：决策引擎与熔断都不存在了，对应后端路由也已删除。
// 策略的启动/停止/状态见下方「策略托管」区块。

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

// ---------------------------------------------------------------- 策略托管

/** 策略合集（策略卡片页） */
export function useStrategies() {
  return useQuery<StrategyDescriptor[]>({
    queryKey: ['strategies'],
    queryFn: () => http.get('/strategy'),
  });
}

/** 策略运行状态（轮询：便于观察网格层数与 tick 结果） */
export function useStrategyStatus(refetchInterval = 5000) {
  return useQuery<StrategyRunStatus>({
    queryKey: ['strategy-status'],
    queryFn: () => http.get('/strategy/status'),
    refetchInterval,
  });
}

/**
 * 启动策略。
 *
 * 注意返回体是 200 + `{ ok:false, blockingLots }` 而非抛错：
 * 「上一轮策略还有仓位没平」是正常的业务分支，不是异常。
 */
export function useStartStrategy() {
  const qc = useQueryClient();
  return useMutation<
    StrategyStartResult,
    Error,
    { name: string; params?: Record<string, unknown> }
  >({
    mutationFn: (body) => http.post('/strategy/start', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['strategy-status'] });
    },
  });
}

/** 停止策略（不自动平仓，持仓保留由用户处理） */
export function useStopStrategy() {
  const qc = useQueryClient();
  return useMutation<StrategyRunStatus, Error, void>({
    mutationFn: () => http.post('/strategy/stop'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['strategy-status'] });
    },
  });
}

// ------------------------------------------------------------ AI 行情分析

/** AI 行情分析（60s 自动刷新，与后端缓存同步） */
export function useAiMarketAnalysis(symbol = 'BTCUSDT') {
  return useQuery<AiMarketAnalysis>({
    queryKey: ['ai-market', symbol],
    queryFn: () => http.get('/ai/market', { params: { symbol } }),
    refetchInterval: 60_000,
  });
}

/** 强制重新分析（绕过后端 60s 缓存） */
export function useRefreshAiMarket() {
  const qc = useQueryClient();
  return useMutation<AiMarketAnalysis, Error, string>({
    mutationFn: (symbol) => http.get('/ai/market', { params: { symbol, force: 'true' } }),
    onSuccess: (data, symbol) => {
      qc.setQueryData(['ai-market', symbol], data);
    },
  });
}
