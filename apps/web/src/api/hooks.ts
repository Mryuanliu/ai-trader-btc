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
  Candle,
  DecisionRecord,
  DecisionSummary,
  Environment,
  KeywordTrend,
  LotDTO,
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
  /** 市场：现货/合约共用订单表，必须隔离查询 */
  market?: 'spot' | 'futures';
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
      void client.invalidateQueries({ queryKey: ['lots'] });
      void client.invalidateQueries({ queryKey: ['positions'] });
    },
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

/** 全量仓位单（含已完结）：订单页按 Lot 分组、对账用 */
export function useAllLots(params: { market?: 'spot' | 'futures'; symbol?: string }) {
  return useQuery<LotDTO[]>({
    queryKey: ['lots', 'all', params],
    queryFn: () => http.get('/lots', { params: { ...params, status: 'all' } }),
    enabled: Boolean(params.market),
    refetchInterval: 30000,
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

// ------------------------------------------------------------------ 合约决策
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
    queryFn: () => http.get('/futures/decisions', { params }),
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
    queryFn: () => http.get('/futures/decisions/stats'),
    refetchInterval: 60000,
  });
}

// ------------------------------------------------------------------ 决策诊断（策略增强 A 期）

/** 信号投票统计：各信号的中性/多/空占比，暴露「信号长期不表态」问题 */
export interface SignalVoteStat {
  name: string;
  label: string;
  total: number;
  neutralRate: number;
  bullishRate: number;
  bearishRate: number;
}

/** 单个信号对综合倾向的贡献 */
export interface SignalContribution {
  name: string;
  label: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  weight: number;
  signed: number;
  note?: string;
}

/** 最接近触发的观望记录（差一点就开仓的） */
export interface NearMiss {
  id: string;
  createdAt: string;
  proximity: number | null;
  blockingReason: string | null;
  score: number | null;
  requiredScore: number | null;
  contributions: SignalContribution[];
}

/** 决策诊断聚合：回答「为什么没开单」 */
export interface DecisionDiagnostics {
  windowHours: number;
  total: number;
  holdTotal: number;
  /** 阻塞原因 Top 排行（含占比） */
  topReasons: { code: string; count: number; share: number }[];
  /** 接近度分布：观望决策堆积在哪个区间 */
  proximityBuckets: { bucket: string; count: number }[];
  /** 最接近触发的观望，供下钻 */
  nearMisses: NearMiss[];
  /** 各信号投票率 */
  signalStats: SignalVoteStat[];
}

// ------------------------------------------------------------------ 回合盈亏（订单页）

/** 一个完整回合（开仓→平仓）的盈亏明细 */
export interface RoundTrip {
  direction: 'long' | 'short';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
  returnPct: number;
  openedAt: number;
  closedAt: number;
  closeOrderId?: string;
}

export interface RoundTripSummary {
  count: number;
  wins: number;
  losses: number;
  totalNetPnl: number;
  winRate: number;
  bestPnl: number;
  worstPnl: number;
}

export interface RoundTripsResponse {
  market: 'spot' | 'futures';
  symbol: string;
  fillCount: number;
  trips: RoundTrip[];
  summary: RoundTripSummary;
}

export function useRoundTrips(symbol?: string) {
  return useQuery<RoundTripsResponse>({
    queryKey: ['round-trips', symbol ?? 'all'],
    queryFn: () =>
      http.get('/orders/round-trips' + (symbol ? `?symbol=${symbol}` : '')),
    refetchInterval: 30000,
  });
}

export function useDecisionDiagnostics(windowHours = 24) {
  return useQuery<DecisionDiagnostics>({
    queryKey: ['decision-diagnostics', windowHours],
    queryFn: () => http.get(`/futures/decisions/diagnostics?windowHours=${windowHours}`),
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
  /** 兼容字段：本项目仅合约回测，忽略现货 */
  market?: 'futures';
  /** 合约杠杆 1~10 */
  leverage?: number;
  /** 合约回测附加 1x/3x/5x 杠杆对比 */
  compareLeverage?: boolean;
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
    /** 合约专属 */
    leverage?: number;
    stepSize?: number;
    minNotional?: number;
    totalFundingPaid?: number;
    liquidationCount?: number;
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
    /** 合约专属 */
    positionSide?: 'LONG' | 'SHORT';
    reduceOnly?: boolean;
    margin?: number;
    notional?: number;
  }[];
  /** compareLeverage=true 时：1x/3x/5x 对比行 */
  comparison?: {
    leverage: number;
    totalReturnPct: number;
    annualizedReturnPct: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    winRate: number;
    profitFactor: number;
    tradeCount: number;
    liquidationCount: number;
    totalFundingPaid: number;
  }[];
  /** 强平事件（合约） */
  liquidations?: {
    time: number;
    price: number;
    loss: number;
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
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
    queryFn: () => http.get(`/futures/decisions/${id}`),
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

export interface FuturesConfigDTO {
  name: string;
  enabled: boolean;
  symbol: string;
  timeframe: string;
  decisionIntervalSec: number;
  mode: string;
  positionPct: number;
  minConfidence: number;
  leverage: number;
  maxLeverage: number;
  marginType: 'isolated' | 'cross';
  liquidationBufferPct: number;
  decisionLane: string;
  strategyName: string;
  strategyParams: Record<string, unknown>;
  exitRules: { stopLossPct: number | null; takeProfitPct: number | null };
  lastRunAt: string | null;
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
  return useQuery<FuturesConfigDTO>({
    queryKey: ['futures', 'config'],
    queryFn: () => http.get('/futures/config'),
    refetchInterval: 10000,
  });
}

export function useUpdateFuturesConfig() {
  const client = useQueryClient();
  return useMutation<FuturesConfigDTO, Error, Record<string, unknown>>({
    mutationFn: (patch) => http.patch('/futures/config', patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['futures', 'config'] });
    },
  });
}

export function useRunFuturesEngine() {
  const client = useQueryClient();
  return useMutation<
    { action: string; confidence: number; lane: string; riskPassed: boolean; orderId: string | null },
    Error,
    void
  >({
    mutationFn: () => http.post('/futures/run'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['futures', 'decisions'] });
      void client.invalidateQueries({ queryKey: ['futures', 'positions'] });
    },
  });
}

export function useFuturesHealth() {
  return useQuery<{ consecutiveFailures: number; nextRetryAt: number; tripped: boolean; running: boolean }>({
    queryKey: ['futures', 'health'],
    queryFn: () => http.get('/futures/health'),
    refetchInterval: 10000,
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
