import { Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import {
  Balance,
  Candle,
  Environment,
  FALLBACK_SYMBOL_FILTERS,
  FundingRate,
  FUTURES_MIN_NOTIONAL,
  FuturesPositionSnapshot,
  KlineQuery,
  MarginType,
  ORDER_STATUSES,
  OrderStatus,
  SymbolFilters,
  Ticker,
} from '@ai-trader/shared';
import {
  CancelOrderInput,
  ExchangeError,
  FuturesExchangeAdapter,
  OrderQuery,
  OrderResult,
  PlaceOrderInput,
  PriceQuote,
  sumCommissionUsdt,
} from './adapter.interface';
import { buildQuery, hmacSha256Hex } from './signature';
import { axiosTransport, wsAgent } from '../common/proxy';

/**
 * 币安 U 本位合约适配器。
 *
 * 与现货的关键差异：
 * - 主机：`demo-fapi.binance.com`（合约 demo 与合约 testnet 是同一个环境）
 * - 持仓：净持仓可为负（空头），以交易所 positionRisk 为权威
 * - 名义价值门槛 100 USDT（现货 5 USDT）
 * - 有强平价、保证金模式（逐仓/全仓）概念
 *
 * 本阶段只打通**只读**链路（行情、账户、持仓、资金费率），
 * 下单类方法显式抛 NOT_IMPLEMENTED，由后续 Commit 的合约执行器接管。
 */
const REST_HOSTS: Record<Environment, string> = {
  demo: 'https://demo-fapi.binance.com',
  // 合约 demo 与合约 testnet 是同一个环境，testnet 同样落到 demo-fapi
  testnet: 'https://demo-fapi.binance.com',
  live: 'https://fapi.binance.com',
};

const WS_HOSTS: Record<Environment, string> = {
  demo: 'wss://demo-fstream.binance.com',
  testnet: 'wss://demo-fstream.binance.com',
  live: 'wss://fstream.binance.com',
};

/** 过滤器缓存时长：交易对规则极少变动，取 24h */
const FILTERS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 账户持仓模式：
 * - one-way 单向持仓（币安默认）：同一标的同时只能有一个方向的仓位，
 *   禁止下发 positionSide，方向由 side + reduceOnly 表达
 * - hedge 双向持仓：可同时持有多空两侧，必须下发 positionSide 区分
 */
export type PositionMode = 'one-way' | 'hedge';

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

/** 解析合约 filters 数组；最小名义门槛按合约口径 100 USDT 兜底（现货是 5） */
function parseFuturesFilters(
  symbol: string,
  filters: { filterType: string; [k: string]: string }[],
): SymbolFilters {
  const pick = (type: string) => filters.find((f) => f.filterType === type);
  const lot = pick('LOT_SIZE');
  const price = pick('PRICE_FILTER');
  const notional = pick('MIN_NOTIONAL');

  return {
    symbol,
    stepSize: Number(lot?.stepSize) || FALLBACK_SYMBOL_FILTERS.stepSize,
    tickSize: Number(price?.tickSize) || FALLBACK_SYMBOL_FILTERS.tickSize,
    minQty: Number(lot?.minQty) || FALLBACK_SYMBOL_FILTERS.minQty,
    maxQty: Number(lot?.maxQty) || FALLBACK_SYMBOL_FILTERS.maxQty,
    minNotional: Number(notional?.notional) || FUTURES_MIN_NOTIONAL,
  };
}

export class BinanceFuturesAdapter implements FuturesExchangeAdapter {
  private readonly logger: Logger;
  readonly code = 'binance-futures' as const;
  /** 已具备下单能力（杠杆/保证金/开平仓均已实现） */
  readonly supportsTrading = true;

  private readonly http: AxiosInstance;
  private readonly sockets = new Set<WebSocket>();
  private readonly filtersCache = new Map<string, { filters: SymbolFilters; cachedAt: number }>();
  /** 账户持仓模式缓存（整个账户级设置，进程内查一次即可） */
  private positionModeCache: PositionMode | null = null;

  constructor(
    readonly environment: Environment,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    this.logger = new Logger(BinanceFuturesAdapter.name);
    this.http = axios.create({
      baseURL: REST_HOSTS[environment],
      timeout: 20000,
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {},
      ...axiosTransport(hostOf(REST_HOSTS[environment])),
    });
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // ---------------------------------------------------------------- 底层请求

  /** 代理链路偶发 ECONNRESET/ETIMEDOUT：仅对无响应的错误重试 */
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

  private async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const query = buildQuery(params);
    const url = query ? `${path}?${query}` : path;
    try {
      const res = await this.withRetry(() => this.http.get<T>(url));
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `${this.http.defaults.baseURL}${url}`);
    }
  }

  private async signed<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new ExchangeError(this.code, 'NO_CREDENTIALS', '币安合约账户未配置 API Key');
    }
    // 与现货一致：本机时钟与币安存在数秒偏差，recvWindow 放宽到 30s 避免 -1021
    const query = buildQuery({ ...params, timestamp: Date.now(), recvWindow: 30_000 });
    const signature = hmacSha256Hex(this.apiSecret, query);
    const url = `${path}?${query}&signature=${signature}`;
    try {
      const res = await this.withRetry(() => this.http.request<T>({ method, url }));
      return res.data;
    } catch (err) {
      throw this.wrapError(err, `${this.http.defaults.baseURL}${path}`);
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
    return new ExchangeError(
      this.code,
      `HTTP_${response?.status ?? code ?? 'NETWORK'}`,
      `币安合约请求失败 ${url} -> ${detail}`,
    );
  }

  // ---------------------------------------------------------------- 公共接口

  async getServerTime(): Promise<number> {
    const data = await this.get<{ serverTime: number }>('/fapi/v1/time');
    return data.serverTime;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const data = await this.get<Record<string, string>>('/fapi/v1/ticker/24hr', { symbol });
    return {
      symbol,
      price: Number(data.lastPrice),
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
    const rows = await this.get<(string | number)[][]>('/fapi/v1/klines', {
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

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const upper = symbol.toUpperCase();
    const now = Date.now();
    const hit = this.filtersCache.get(upper);
    if (hit && now - hit.cachedAt < FILTERS_TTL_MS) return hit.filters;

    const fallback: SymbolFilters = {
      symbol: upper,
      ...FALLBACK_SYMBOL_FILTERS,
      minNotional: FUTURES_MIN_NOTIONAL,
    };
    try {
      const data = await this.get<{
        symbols: { symbol: string; filters: { filterType: string; [k: string]: string }[] }[];
      }>('/fapi/v1/exchangeInfo', { symbol: upper });

      const entry = data.symbols?.find((s) => s.symbol === upper);
      if (!entry) return fallback;

      const filters = parseFuturesFilters(upper, entry.filters ?? []);
      this.filtersCache.set(upper, { filters, cachedAt: now });
      return filters;
    } catch (err) {
      this.logger.warn(`获取 ${upper} 合约过滤器失败，使用兜底值: ${(err as Error).message}`);
      return fallback;
    }
  }

  // ---------------------------------------------------------------- 账户接口

  /**
   * 合约钱包余额。
   * 语义映射：free = availableBalance（可开仓保证金），total = balance（钱包余额）。
   */
  async getBalances(): Promise<Balance[]> {
    const data = await this.signed<
      {
        asset: string;
        balance: string;
        availableBalance: string;
      }[]
    >('GET', '/fapi/v2/balance');

    return data
      .map((b) => {
        const total = Number(b.balance);
        const free = Number(b.availableBalance);
        return {
          asset: b.asset,
          free,
          locked: Math.max(0, total - free),
          total,
        };
      })
      .filter((b) => b.total > 0);
  }

  /**
   * 持仓风险：以交易所返回的 positionRisk 为权威，不在本地推导。
   * 未传 symbol 时返回全部合约持仓（含空仓标的），调用方按需过滤。
   */
  async getPositions(symbol?: string): Promise<FuturesPositionSnapshot[]> {
    const data = await this.signed<
      {
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        liquidationPrice: string;
        leverage: string;
        marginType: string;
        isolatedMargin: string;
        notional: string;
      }[]
    >('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {});

    return data.map((p) => {
      const quantity = Number(p.positionAmt);
      const markPrice = Number(p.markPrice);
      const liquidationPrice = Number(p.liquidationPrice);
      const notional = Math.abs(quantity) * markPrice;

      // 距强平距离方向感知：多头看下跌空间，空头看上涨空间
      let liquidationDistancePct: number | null = null;
      if (quantity !== 0 && liquidationPrice > 0 && markPrice > 0) {
        liquidationDistancePct =
          quantity > 0
            ? (markPrice - liquidationPrice) / markPrice
            : (liquidationPrice - markPrice) / markPrice;
      }

      return {
        symbol: p.symbol,
        quantity,
        entryPrice: Number(p.entryPrice),
        markPrice,
        liquidationPrice,
        leverage: Number(p.leverage),
        marginType: p.marginType === 'isolated' ? 'isolated' : 'cross',
        isolatedMargin: Number(p.isolatedMargin),
        unrealizedPnl: Number(p.unRealizedProfit),
        notional,
        liquidationDistancePct,
      };
    });
  }

  /** 历史资金费率（公共接口，无需密钥），按时间倒序返回 */
  async getFundingRates(symbol: string, limit = 100): Promise<FundingRate[]> {
    const data = await this.get<
      { symbol: string; fundingRate: string; fundingTime: number; markPrice?: string }[]
    >('/fapi/v1/fundingRate', { symbol, limit });

    return data.map((r) => ({
      symbol: r.symbol,
      fundingTime: Number(r.fundingTime),
      rate: Number(r.fundingRate),
      markPrice: r.markPrice !== undefined ? Number(r.markPrice) : undefined,
    }));
  }

  // ---------------------------------------------------------------- 订阅行情

  subscribeKlines(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle) => void,
  ): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(
      `${WS_HOSTS[this.environment]}/ws/${stream}`,
      wsAgent(hostOf(WS_HOSTS[this.environment])),
    );
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

  subscribeTicker(symbol: string, onQuote: (quote: PriceQuote) => void): () => void {
    const stream = `${symbol.toLowerCase()}@bookTicker`;
    const ws = new WebSocket(
      `${WS_HOSTS[this.environment]}/ws/${stream}`,
      wsAgent(hostOf(WS_HOSTS[this.environment])),
    );
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

  // ---------------------------------------------------------------- 杠杆与保证金

  /**
   * 设置杠杆。
   *
   * 交易所对重复设置同一杠杆会返回 -4028（Leverage is invalid / 无变化），
   * 这属于幂等成功，不当作失败抛出，否则每次开仓前的例行设置都会报错。
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/4028|Leverage is invalid|leverage not changed/i.test(msg)) {
        this.logger.log(`${symbol} 杠杆已为 ${leverage} 倍，无需重复设置`);
        return;
      }
      throw err;
    }
  }

  /**
   * 设置保证金模式（逐仓 / 全仓）。
   *
   * 两个坑（均已实测）：
   * 1. 枚举值必须**大写**（ISOLATED / CROSS）。传小写 isolated 时币安返回
   *    -1102「Mandatory parameter 'margintype' was not sent」——文案极具误导性，
   *    实际是值校验失败而非参数缺失，排查时容易误以为参数名或传参方式有问题。
   * 2. 重复设置同一模式返回 -4046（No need to change margin type），属幂等成功，不当作失败。
   */
  async setMarginType(symbol: string, marginType: MarginType): Promise<void> {
    const value = marginType.toUpperCase();
    try {
      await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType: value });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/4046|No need to change margin type/i.test(msg)) {
        this.logger.log(`${symbol} 保证金模式已为 ${marginType}，无需重复设置`);
        return;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- 下单

  /**
   * 读取账户持仓模式（缓存）。
   *
   * 探测失败时按单向持仓处理：这是币安的默认模式，
   * 且不下发 positionSide 的行为在两种模式下都更保守（顶多被要求补参数，不会下错方向）。
   */
  async getPositionMode(): Promise<PositionMode> {
    if (this.positionModeCache) return this.positionModeCache;
    try {
      const data = await this.signed<{ dualSidePosition: boolean }>(
        'GET',
        '/fapi/v1/positionSide/dual',
      );
      const mode: PositionMode = data.dualSidePosition ? 'hedge' : 'one-way';
      this.positionModeCache = mode;
      this.logger.log(`合约账户持仓模式：${mode === 'hedge' ? '双向持仓' : '单向持仓'}`);
      return mode;
    } catch (err) {
      this.logger.warn(`读取持仓模式失败，按单向持仓处理: ${(err as Error).message}`);
      return 'one-way';
    }
  }

  /**
   * 切换持仓模式（one-way ↔ hedge）。已是目标模式时静默返回（幂等）。
   *
   * 前提：账户无任何持仓，否则交易所拒绝（-4067）。
   * Lot 模型要求多空共存（锁仓），因此真实交易前必须处于 hedge 模式；
   * 单向模式下 hedging 关闭，positionRisk 只返回一条净持仓记录，
   * 无法表达多空两侧独立的止盈止损。
   */
  async setPositionMode(dual: boolean): Promise<PositionMode> {
    const current = await this.getPositionMode();
    if ((current === 'hedge') === dual) return current;

    await this.signed('POST', '/fapi/v1/positionSide/dual', {
      dualSidePosition: dual ? 'true' : 'false',
    });
    // 切换成功后失效缓存，让后续读取拿到新模式
    this.positionModeCache = dual ? 'hedge' : 'one-way';
    this.logger.log(`合约持仓模式已切换为：${dual ? '双向持仓（hedge）' : '单向持仓'}`);
    return this.positionModeCache;
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      // 同现货：FULL 才带 fills[].commission，手续费是盈亏口径的关键输入
      newOrderRespType: 'FULL',
    };
    if (input.type === 'LIMIT') {
      payload.price = input.price;
      payload.timeInForce = 'GTC';
    }

    // 单向持仓模式下**不能**下发 positionSide，否则交易所返回
    // -4061「Order's position side does not match user's setting」。
    // 此时方向完全由 side + reduceOnly 表达：BUY/SELL 决定开仓方向，
    // reduceOnly 决定是平仓还是开仓。
    const mode = await this.getPositionMode();
    if (mode === 'hedge' && input.positionSide) {
      payload.positionSide = input.positionSide;
    }

    if (input.reduceOnly) payload.reduceOnly = 'true';
    if (input.clientOrderId) payload.newClientOrderId = input.clientOrderId;

    const data = await this.signed<Record<string, any>>('POST', '/fapi/v1/order', payload);
    const result = this.normalizeOrder(data, input);

    /**
     * 成交价回查。
     *
     * 实测：demo 环境的 POST /fapi/v1/order 响应**不含** avgPrice 与 cumQuote
     * （只有 executedQty / cumQty / price=0），成交均价无法从下单响应推导；
     * 而 GET /fapi/v1/order 查询响应两者都有。
     * 因此已成交但拿不到成交价时回查一次，拿权威均价。
     * 下单不是热路径（受决策间隔与风控频率约束），多一跳调用可接受。
     */
    if (result.filledQuantity > 0 && !(result.filledPrice > 0)) {
      try {
        const detail = await this.signed<Record<string, any>>('GET', '/fapi/v1/order', {
          symbol: input.symbol,
          orderId: result.exchangeOrderId,
        });
        const avg = Number(detail.avgPrice ?? 0);
        const cumQuote = Number(detail.cumQuote ?? 0);
        const fallback =
          cumQuote > 0 && result.filledQuantity > 0 ? cumQuote / result.filledQuantity : 0;
        const filledPrice = avg > 0 ? avg : fallback;
        if (filledPrice > 0) {
          result.filledPrice = filledPrice;
          result.price = filledPrice;
        }
      } catch (err) {
        // 回查失败不阻断下单流程，成交价留空由上层按保价处理
        this.logger.warn(`回查成交均价失败，成交价留空: ${(err as Error).message}`);
      }
    }

    return result;
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderResult> {
    const data = await this.signed<Record<string, any>>('DELETE', '/fapi/v1/order', {
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
    const data = await this.signed<Record<string, any>>('GET', '/fapi/v1/order', {
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
    const data = await this.signed<Record<string, any>[]>('GET', '/fapi/v1/openOrders', { symbol });
    return data.map((row) =>
      this.normalizeOrder(row, {
        symbol: row.symbol,
        side: row.side,
        type: row.type,
        quantity: Number(row.origQty ?? 0),
      }),
    );
  }

  private normalizeOrder(data: Record<string, any>, fallback: PlaceOrderInput): OrderResult {
    const status = STATUS_MAP[String(data.status)] ?? 'NEW';
    const executedQty = Number(data.executedQty ?? 0);
    const cumQuote = Number(data.cumQuote ?? 0);
    const avgPrice = Number(data.avgPrice ?? 0);

    // 成交均价优先取 avgPrice：下单响应（newOrderRespType=RESULT）不含 cumQuote，
    // 只用 cumQuote/executedQty 会算出 0，导致已成交订单的成交价显示为 0。
    const computed = executedQty > 0 && cumQuote > 0 ? cumQuote / executedQty : 0;
    const filledPrice = avgPrice > 0 ? avgPrice : computed;

    return {
      exchangeOrderId: String(data.orderId ?? ''),
      clientOrderId: String(data.clientOrderId ?? fallback.clientOrderId ?? ''),
      symbol: String(data.symbol ?? fallback.symbol),
      side: (data.side ?? fallback.side) as OrderResult['side'],
      type: (data.type ?? fallback.type) as OrderResult['type'],
      status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : 'NEW',
      price: avgPrice > 0 ? avgPrice : Number(data.price ?? fallback.price ?? 0),
      quantity: Number(data.origQty ?? fallback.quantity ?? 0),
      filledQuantity: executedQty,
      filledPrice,
      // 仅在成交时折算；未成交订单没有 fills，fee 保持 undefined（未知而非 0）
      ...(executedQty > 0 ? sumCommissionUsdt(data, filledPrice) : {}),
      raw: data,
    };
  }
}
