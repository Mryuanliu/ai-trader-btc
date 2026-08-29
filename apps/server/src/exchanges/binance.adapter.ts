import { Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import {
  Balance,
  Candle,
  Environment,
  FALLBACK_SYMBOL_FILTERS,
  KlineQuery,
  ORDER_STATUSES,
  OrderStatus,
  SymbolFilters,
  Ticker,
} from '@ai-trader/shared';
import {
  CancelOrderInput,
  ExchangeAdapter,
  ExchangeError,
  OrderQuery,
  OrderResult,
  PlaceOrderInput,
  PriceQuote,
} from './adapter.interface';
import { buildQuery, hmacSha256Hex } from './signature';
import { axiosTransport, wsAgent } from '../common/proxy';

/**
 * 币安端点（官方文档：https://developers.binance.com/docs/products/spot/demo-mode/general-info）
 *
 * 模拟交易（Demo Mode）除主机域名外，路径、/api 前缀、X-MBX-APIKEY 头、
 * HMAC-SHA256 签名规则与现货 API 完全一致。
 */
const REST_HOSTS: Record<Environment, string> = {
  demo: 'https://demo-api.binance.com',
  testnet: 'https://testnet.binance.vision',
  live: 'https://api.binance.com',
};

const WS_HOSTS: Record<Environment, string> = {
  demo: 'wss://demo-stream.binance.com',
  testnet: 'wss://testnet.binance.vision',
  live: 'wss://stream.binance.com:9443',
};

/** 公共行情域名：无需密钥、不限账户，用于 K 线与行情流 */
const PUBLIC_REST_HOST = 'https://data-api.binance.vision';
const PUBLIC_WS_HOST = 'wss://data-stream.binance.vision';

/** 过滤器缓存时长：交易对规则极少变动，取 24h */
const FILTERS_TTL_MS = 24 * 60 * 60 * 1000;

/** 解析币安 filters 数组，缺失项回落到兜底值 */
function parseBinanceFilters(
  symbol: string,
  filters: { filterType: string; [k: string]: string }[],
): SymbolFilters {
  const pick = (type: string) => filters.find((f) => f.filterType === type);
  const lot = pick('LOT_SIZE');
  const price = pick('PRICE_FILTER');
  const notional = pick('NOTIONAL') ?? pick('MIN_NOTIONAL');

  return {
    symbol,
    stepSize: Number(lot?.stepSize) || FALLBACK_SYMBOL_FILTERS.stepSize,
    tickSize: Number(price?.tickSize) || FALLBACK_SYMBOL_FILTERS.tickSize,
    minQty: Number(lot?.minQty) || FALLBACK_SYMBOL_FILTERS.minQty,
    maxQty: Number(lot?.maxQty) || FALLBACK_SYMBOL_FILTERS.maxQty,
    minNotional: Number(notional?.minNotional) || FALLBACK_SYMBOL_FILTERS.minNotional,
  };
}

const STATUS_MAP: Record<string, OrderStatus> = {
  NEW: 'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  PENDING_CANCEL: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class BinanceAdapter implements ExchangeAdapter {
  private readonly logger: Logger;
  readonly code = 'binance' as const;
  /** 交易通道：走账户环境主机，携带 API Key */
  private readonly tradeHttp: AxiosInstance;
  /** 公共行情通道：走公共域名，不携带密钥，不受账户权重限制 */
  private readonly publicHttp: AxiosInstance;
  private readonly sockets = new Set<WebSocket>();
  private readonly filtersCache = new Map<string, { filters: SymbolFilters; cachedAt: number }>();

  constructor(
    readonly environment: Environment,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    this.logger = new Logger(BinanceAdapter.name);
    this.tradeHttp = axios.create({
      baseURL: REST_HOSTS[environment],
      timeout: 20000,
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {},
      ...axiosTransport(hostOf(REST_HOSTS[environment])),
    });
    this.publicHttp = axios.create({
      baseURL: PUBLIC_REST_HOST,
      timeout: 20000,
      ...axiosTransport(hostOf(PUBLIC_REST_HOST)),
    });
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /** 交易通道基址（错误信息与日志用） */
  get tradeBaseUrl(): string {
    return REST_HOSTS[this.environment];
  }

  // ---------------------------------------------------------------- 底层请求

  /**
   * 代理链路偶发 ECONNRESET/ETIMEDOUT（实测失败率 ~10%）：网络层错误统一重试。
   * 仅对无响应的错误重试（response 已返回的 HTTP 错误是确定性结果，重试无意义）。
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const hasResponse = (err as { response?: unknown })?.response !== undefined;
        if (hasResponse || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw lastErr;
  }

  private async get<T>(
    client: AxiosInstance,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const query = buildQuery(params);
    const url = query ? `${path}?${query}` : path;
    try {
      const res = await this.withRetry(() => client.get<T>(url));
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `${client.defaults.baseURL}${url}`);
    }
  }

  private async signed<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new ExchangeError(this.code, 'NO_CREDENTIALS', '币安账户未配置 API Key');
    }
    // 本机时钟与币安服务器可能偏差数秒（实测 ~4.8s）：recvWindow 5000 几乎无余量，
    // 会间歇性报 -1021。放宽到 30000 为代理链路延迟与时钟漂移留足余量
    const query = buildQuery({ ...params, timestamp: Date.now(), recvWindow: 30_000 });
    const signature = hmacSha256Hex(this.apiSecret, query);
    const url = `${path}?${query}&signature=${signature}`;
    try {
      const res = await this.withRetry(() => this.tradeHttp.request<T>({ method, url }));
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `${this.tradeHttp.defaults.baseURL}${url}`);
    }
  }

  private wrapError(err: unknown, url: string): ExchangeError {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    const code = (err as { code?: string })?.code;
    let detail: string;
    if (response) {
      detail = `HTTP ${response.status} ${JSON.stringify(response.data)}`;
    } else if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      detail = '请求超时（可能是网络不通或未配置代理）';
    } else if (code) {
      detail = `网络错误 ${code}`;
    } else {
      detail = (err as Error)?.message ?? '未知错误';
    }
    return new ExchangeError(this.code, `HTTP_${response?.status ?? code ?? 'NETWORK'}`, `币安请求失败 ${url} -> ${detail}`);
  }

  // ---------------------------------------------------------------- 公共接口
  async getServerTime(): Promise<number> {
    const data = await this.get<{ serverTime: number }>(
      this.tradeHttp,
      '/api/v3/time',
    );
    return data.serverTime;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const data = await this.get<Record<string, string>>(this.publicHttp, '/api/v3/ticker/24hr', {
      symbol,
    });
    const price = Number(data.lastPrice);
    return {
      symbol,
      price,
      change24h: Number(data.priceChange),
      changePercent24h: Number(data.priceChangePercent),
      high24h: Number(data.highPrice),
      low24h: Number(data.lowPrice),
      volume24h: Number(data.volume),
      quoteVolume24h: Number(data.quoteVolume),
      ts: Number(data.closeTime) || Date.now(),
    };
  }

  async getKlines(query: KlineQuery): Promise<Candle[]> {
    const rows = await this.get<(string | number)[][]>(this.publicHttp, '/api/v3/klines', {
      symbol: query.symbol,
      interval: query.interval,
      limit: query.limit ?? 300,
      startTime: query.startTime,
      endTime: query.endTime,
    });
    return rows.map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }

  /**
   * 取交易对过滤器并按 symbol 缓存 24h。
   * exchangeInfo 全量响应约 1MB，只在首次下单前按需拉取，不进入行情与决策热路径。
   */
  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const upper = symbol.toUpperCase();
    const now = Date.now();
    const hit = this.filtersCache.get(upper);
    if (hit && now - hit.cachedAt < FILTERS_TTL_MS) return hit.filters;

    const fallback: SymbolFilters = { symbol: upper, ...FALLBACK_SYMBOL_FILTERS };
    try {
      const data = await this.get<{
        symbols: { symbol: string; filters: { filterType: string; [k: string]: string }[] }[];
      }>(this.publicHttp, '/api/v3/exchangeInfo', { symbol: upper });

      const entry = data.symbols?.find((s) => s.symbol === upper);
      if (!entry) return fallback;

      const filters = parseBinanceFilters(upper, entry.filters ?? []);
      this.filtersCache.set(upper, { filters, cachedAt: now });
      return filters;
    } catch (err) {
      // 过滤器获取失败不阻断下单，回落兜底值后由交易所返回具体错误
      this.logger.warn(`获取 ${upper} 过滤器失败，使用兜底值: ${(err as Error).message}`);
      return fallback;
    }
  }

  // ---------------------------------------------------------------- 账户接口
  async getBalances(): Promise<Balance[]> {
    const data = await this.signed<{
      balances: { asset: string; free: string; locked: string }[];
    }>('GET', '/api/v3/account');
    return data.balances
      .map((b) => ({
        asset: b.asset,
        free: Number(b.free),
        locked: Number(b.locked),
        total: Number(b.free) + Number(b.locked),
      }))
      .filter((b) => b.total > 0);
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      newOrderRespType: 'RESULT',
    };
    if (input.type === 'LIMIT') {
      payload.price = input.price;
      payload.timeInForce = 'GTC';
    }
    if (input.clientOrderId) payload.newClientOrderId = input.clientOrderId;

    const data = await this.signed<Record<string, any>>('POST', '/api/v3/order', payload);
    return this.normalizeOrder(data, input);
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderResult> {
    const data = await this.signed<Record<string, any>>('DELETE', '/api/v3/order', {
      symbol: input.symbol,
      orderId: input.exchangeOrderId,
      origClientOrderId: input.clientOrderId,
    });
    return this.normalizeOrder(data, {
      symbol: input.symbol,
      side: data.side ?? 'BUY',
      type: data.type ?? 'LIMIT',
      quantity: Number(data.origQty ?? 0),
    });
  }

  async getOrder(query: OrderQuery): Promise<OrderResult> {
    const data = await this.signed<Record<string, any>>('GET', '/api/v3/order', {
      symbol: query.symbol,
      orderId: query.exchangeOrderId,
      origClientOrderId: query.clientOrderId,
    });
    return this.normalizeOrder(data, {
      symbol: query.symbol,
      side: data.side ?? 'BUY',
      type: data.type ?? 'LIMIT',
      quantity: Number(data.origQty ?? 0),
    });
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const data = await this.signed<Record<string, any>[]>('GET', '/api/v3/openOrders', { symbol });
    return data.map((row) =>
      this.normalizeOrder(row, {
        symbol: row.symbol,
        side: row.side,
        type: row.type,
        quantity: Number(row.origQty ?? 0),
      }),
    );
  }

  subscribeKlines(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle) => void,
  ): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(`${PUBLIC_WS_HOST}/ws/${stream}`, wsAgent(hostOf(PUBLIC_WS_HOST)));
    this.sockets.add(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const k = msg?.k;
        if (!k) return;
        onCandle({
          time: k.t,
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        });
      } catch {
        // 忽略无法解析的帧
      }
    });
    ws.on('error', () => {
      /* 由外层重连逻辑处理 */
    });

    return () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      this.sockets.delete(ws);
    };
  }

  /**
   * 高频价格：订阅最优买卖价流（约 100ms 一帧），取中间价。
   * 相比逐笔成交流，中间价不受单笔大额成交影响，抖动更小。
   */
  subscribeTicker(symbol: string, onQuote: (quote: PriceQuote) => void): () => void {
    const stream = `${symbol.toLowerCase()}@bookTicker`;
    const ws = new WebSocket(`${PUBLIC_WS_HOST}/ws/${stream}`, wsAgent(hostOf(PUBLIC_WS_HOST)));
    this.sockets.add(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const bid = Number(msg?.b);
        const ask = Number(msg?.a);
        if (!(bid > 0) || !(ask > 0)) return;
        onQuote({ price: (bid + ask) / 2, ts: Date.now() });
      } catch {
        // 忽略无法解析的帧
      }
    });
    ws.on('error', () => {
      /* 由外层重连逻辑处理 */
    });

    return () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      this.sockets.delete(ws);
    };
  }

  private normalizeOrder(data: Record<string, any>, fallback: PlaceOrderInput): OrderResult {
    const status = STATUS_MAP[String(data.status)] ?? 'NEW';
    const executedQty = Number(data.executedQty ?? 0);
    const cummulativeQuoteQty = Number(data.cummulativeQuoteQty ?? 0);
    return {
      exchangeOrderId: String(data.orderId ?? ''),
      clientOrderId: String(data.clientOrderId ?? fallback.clientOrderId ?? ''),
      symbol: String(data.symbol ?? fallback.symbol),
      side: (data.side ?? fallback.side) as OrderResult['side'],
      type: (data.type ?? fallback.type) as OrderResult['type'],
      status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : 'NEW',
      price: Number(data.price ?? fallback.price ?? 0),
      quantity: Number(data.origQty ?? fallback.quantity ?? 0),
      filledQuantity: executedQty,
      filledPrice: executedQty > 0 ? cummulativeQuoteQty / executedQty : 0,
      raw: data,
    };
  }
}
