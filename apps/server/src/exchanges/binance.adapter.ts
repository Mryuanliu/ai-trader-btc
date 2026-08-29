import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import {
  Balance,
  Candle,
  Environment,
  KlineQuery,
  ORDER_STATUSES,
  OrderStatus,
  Ticker,
} from '@ai-trader/shared';
import {
  CancelOrderInput,
  ExchangeAdapter,
  ExchangeError,
  OrderQuery,
  OrderResult,
  PlaceOrderInput,
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
  readonly code = 'binance' as const;
  /** 交易通道：走账户环境主机，携带 API Key */
  private readonly tradeHttp: AxiosInstance;
  /** 公共行情通道：走公共域名，不携带密钥，不受账户权重限制 */
  private readonly publicHttp: AxiosInstance;
  private readonly sockets = new Set<WebSocket>();

  constructor(
    readonly environment: Environment,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
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
  private async get<T>(
    client: AxiosInstance,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const query = buildQuery(params);
    const url = query ? `${path}?${query}` : path;
    try {
      const res = await client.get<T>(url);
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
    const query = buildQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
    const signature = hmacSha256Hex(this.apiSecret, query);
    const url = `${path}?${query}&signature=${signature}`;
    try {
      const res = await this.tradeHttp.request<T>({ method, url });
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
