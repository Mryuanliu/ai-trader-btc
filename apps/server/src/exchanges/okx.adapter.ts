import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import {
  Balance,
  Candle,
  Environment,
  KlineQuery,
  OrderStatus,
  Ticker,
  Timeframe,
} from '@ai-trader/shared';
import {
  CancelOrderInput,
  ExchangeAdapter,
  ExchangeError,
  OrderQuery,
  OrderResult,
  PlaceOrderInput,
} from './adapter.interface';
import { buildQuery, hmacSha256Base64, okxTimestamp } from './signature';
import { axiosTransport, wsAgent } from '../common/proxy';

/**
 * OKX 无独立的 Demo 域名，模拟盘通过 `x-simulated-trading: 1` 请求头区分。
 * 因此 demo 与 live 共用同一主机，仅 WS 的模拟盘走 wspap 通道。
 */
const REST_HOST = 'https://www.okx.com';
const WS_HOSTS: Record<Environment, string> = {
  demo: 'wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999',
  testnet: 'wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999',
  live: 'wss://ws.okx.com:8443/ws/v5/public',
};

const BAR_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

const STATUS_MAP: Record<string, OrderStatus> = {
  live: 'NEW',
  partially_filled: 'PARTIALLY_FILLED',
  filled: 'FILLED',
  canceled: 'CANCELED',
  mmp_canceled: 'CANCELED',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** BTCUSDT -> BTC-USDT */
function toInstId(symbol: string): string {
  if (symbol.includes('-')) return symbol;
  const match = symbol.match(/^([A-Z]+)(USDT|USDC|BUSD)$/);
  if (match) return `${match[1]}-${match[2]}`;
  return symbol;
}

export class OkxAdapter implements ExchangeAdapter {
  readonly code = 'okx' as const;
  private readonly http: AxiosInstance;
  private readonly sockets = new Set<WebSocket>();
  /** OKX Demo 盘通过 header 区分，非单独域名 */
  private readonly simulated: boolean;

  constructor(
    readonly environment: Environment,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly passphrase: string,
  ) {
    // demo 与 testnet 均为模拟环境，走 x-simulated-trading 头
    this.simulated = environment !== 'live';
    this.http = axios.create({
      baseURL: REST_HOST,
      timeout: 20000,
      ...axiosTransport(hostOf(REST_HOST)),
    });
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret && this.passphrase);
  }

  private authHeaders(method: string, path: string, body = ''): Record<string, string> {
    const timestamp = okxTimestamp();
    const sign = hmacSha256Base64(this.apiSecret, `${timestamp}${method}${path}${body}`);
    return {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
      ...(this.simulated ? { 'x-simulated-trading': '1' } : {}),
    };
  }

  private async publicGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const query = buildQuery(params);
    const url = query ? `${path}?${query}` : path;
    try {
      const res = await this.http.get<T>(url);
      return res.data;
    } catch (err) {
      throw this.wrapError(err, url);
    }
  }

  private async signed<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new ExchangeError(this.code, 'NO_CREDENTIALS', '欧意账户未配置 API Key / Passphrase');
    }
    const fullPath = method === 'GET' && body ? `${path}?${buildQuery(body)}` : path;
    const payload = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    try {
      const res = await this.http.request<T>({
        method,
        url: fullPath,
        data: method === 'POST' ? payload : undefined,
        headers: this.authHeaders(method, fullPath, payload),
      });
      return res.data;
    } catch (err) {
      throw this.wrapError(err, fullPath);
    }
  }

  private wrapError(err: unknown, url: string): ExchangeError {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    const detail = response?.data ? JSON.stringify(response.data) : (err as Error)?.message;
    return new ExchangeError(this.code, `HTTP_${response?.status ?? 'NETWORK'}`, `欧意请求失败 ${url}: ${detail}`);
  }

  async getServerTime(): Promise<number> {
    const data = await this.publicGet<{ data: { ts: string }[] }>('/api/v5/public/time');
    return Number(data.data?.[0]?.ts ?? Date.now());
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const instId = toInstId(symbol);
    const data = await this.publicGet<{ data: Record<string, string>[] }>('/api/v5/market/ticker', {
      instId,
    });
    const row = data.data?.[0] ?? {};
    const price = Number(row.last);
    const open24h = Number(row.open24h);
    return {
      symbol,
      price,
      change24h: price - open24h,
      changePercent24h: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      high24h: Number(row.high24h),
      low24h: Number(row.low24h),
      volume24h: Number(row.vol24h),
      quoteVolume24h: Number(row.volCcy24h),
      ts: Number(row.ts) || Date.now(),
    };
  }

  async getKlines(query: KlineQuery): Promise<Candle[]> {
    const instId = toInstId(query.symbol);
    const data = await this.publicGet<{ data: string[][] }>('/api/v5/market/candles', {
      instId,
      bar: BAR_MAP[query.interval] ?? '1m',
      limit: query.limit ?? 300,
    });
    // OKX 返回按时间倒序
    return (data.data ?? [])
      .map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getBalances(): Promise<Balance[]> {
    const data = await this.signed<{
      data: { details: { ccy: string; availBal: string; frozenBal: string }[] }[];
    }>('GET', '/api/v5/account/balance');
    const details = data.data?.[0]?.details ?? [];
    return details
      .map((d) => ({
        asset: d.ccy,
        free: Number(d.availBal),
        locked: Number(d.frozenBal),
        total: Number(d.availBal) + Number(d.frozenBal),
      }))
      .filter((b) => b.total > 0);
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderResult> {
    const instId = toInstId(input.symbol);
    const body: Record<string, unknown> = {
      instId,
      tdMode: 'cash',
      side: input.side.toLowerCase(),
      ordType: input.type === 'MARKET' ? 'market' : 'limit',
      sz: String(input.quantity),
      ...(input.clientOrderId ? { clOrdId: input.clientOrderId } : {}),
    };
    if (input.type === 'LIMIT') body.px = String(input.price);

    const data = await this.signed<{ data: Record<string, string>[] }>('POST', '/api/v5/trade/order', body);
    const result = data.data?.[0] ?? {};
    if (result.sCode && result.sCode !== '0') {
      throw new ExchangeError(this.code, String(result.sCode), `欧意下单失败: ${result.sMsg}`);
    }
    return this.getOrder({ symbol: input.symbol, exchangeOrderId: result.ordId, clientOrderId: input.clientOrderId });
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderResult> {
    const instId = toInstId(input.symbol);
    const data = await this.signed<{ data: Record<string, string>[] }>(
      'POST',
      '/api/v5/trade/cancel-order',
      {
        instId,
        ordId: input.exchangeOrderId,
        clOrdId: input.clientOrderId,
      },
    );
    const result = data.data?.[0] ?? {};
    return {
      exchangeOrderId: String(result.ordId ?? input.exchangeOrderId ?? ''),
      clientOrderId: String(result.clOrdId ?? input.clientOrderId ?? ''),
      symbol: input.symbol,
      side: 'BUY',
      type: 'LIMIT',
      status: 'CANCELED',
      price: 0,
      quantity: 0,
      filledQuantity: 0,
      filledPrice: 0,
      raw: result,
    };
  }

  async getOrder(query: OrderQuery): Promise<OrderResult> {
    const instId = toInstId(query.symbol);
    const params: Record<string, string> = { instId };
    if (query.exchangeOrderId) params.ordId = query.exchangeOrderId;
    if (query.clientOrderId) params.clOrdId = query.clientOrderId;

    const data = await this.signed<{ data: Record<string, string>[] }>(
      'GET',
      '/api/v5/trade/order',
      params,
    );
    const row = data.data?.[0] ?? {};
    return this.normalizeOrder(row, query, instId);
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const data = await this.signed<{ data: Record<string, string>[] }>(
      'GET',
      '/api/v5/trade/orders-pending',
      symbol ? { instId: toInstId(symbol) } : {},
    );
    return (data.data ?? []).map((row) => this.normalizeOrder(row, { symbol: row.instId ?? '' }, toInstId(row.instId ?? '')));
  }

  subscribeKlines(symbol: string, interval: string, onCandle: (candle: Candle) => void): () => void {
    const instId = toInstId(symbol);
    const channel = `candle${BAR_MAP[interval as Timeframe] ?? '1m'}`;
    const ws = new WebSocket(
      WS_HOSTS[this.environment],
      wsAgent(hostOf(WS_HOSTS[this.environment])),
    );
    this.sockets.add(ws);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: [{ channel, instId }],
        }),
      );
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg?.data?.length) return;
        for (const row of msg.data) {
          // OKX candle: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
          onCandle({
            time: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
          });
        }
      } catch {
        /* 忽略无法解析的帧 */
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

  private normalizeOrder(
    row: Record<string, string>,
    fallback: { symbol: string; side?: string; type?: string; quantity?: number },
    instId: string,
  ): OrderResult {
    const filledQty = Number(row.accFillSz ?? row.fillSz ?? 0);
    const avgPx = Number(row.avgPx ?? row.px ?? 0);
    return {
      exchangeOrderId: String(row.ordId ?? ''),
      clientOrderId: String(row.clOrdId ?? ''),
      symbol: fallback.symbol || instId,
      side: String(row.side ?? fallback.side ?? 'buy').toUpperCase() as OrderResult['side'],
      type: String(row.ordType ?? fallback.type ?? 'limit').toUpperCase() as OrderResult['type'],
      status: STATUS_MAP[String(row.state)] ?? 'NEW',
      price: Number(row.px ?? 0),
      quantity: Number(row.sz ?? fallback.quantity ?? 0),
      filledQuantity: filledQty,
      filledPrice: avgPx,
      raw: row,
    };
  }
}
