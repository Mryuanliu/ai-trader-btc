import {
  Balance,
  Candle,
  Environment,
  ExchangeCode,
  KlineQuery,
  OrderSide,
  OrderStatus,
  OrderType,
  SymbolFilters,
  Ticker,
} from '@ai-trader/shared';

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  environment: Environment;
}

export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  clientOrderId?: string;
}

export interface CancelOrderInput {
  symbol: string;
  exchangeOrderId?: string;
  clientOrderId?: string;
}

export interface OrderQuery {
  symbol: string;
  exchangeOrderId?: string;
  clientOrderId?: string;
}

export interface OrderResult {
  exchangeOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: number;
  quantity: number;
  filledQuantity: number;
  filledPrice: number;
  raw?: unknown;
}

/**
 * 高频行情报价：来自逐笔成交或最优买卖价流，
 * 刷新频率远高于 K 线流，用于顶栏价格与实时指标。
 */
export interface PriceQuote {
  /** 报价（币安取买卖中间价，欧意取最新成交价） */
  price: number;
  /** 行情时间戳（毫秒） */
  ts: number;
}

/** 交易所统一能力契约，新增交易所只需再实现一次该接口 */
export interface ExchangeAdapter {
  readonly code: ExchangeCode;
  readonly environment: Environment;
  /** 是否配置了可用密钥（无密钥时仅能使用公共行情） */
  readonly hasCredentials: boolean;

  getServerTime(): Promise<number>;
  getTicker(symbol: string): Promise<Ticker>;
  getKlines(query: KlineQuery): Promise<Candle[]>;
  getBalances(): Promise<Balance[]>;
  /**
   * 取交易对过滤器（数量/价格步进、最小名义价值），由适配器内部缓存。
   * 获取失败时回落到兜底值而不抛异常，交由下单后的交易所错误来暴露。
   */
  getSymbolFilters(symbol: string): Promise<SymbolFilters>;
  placeOrder(input: PlaceOrderInput): Promise<OrderResult>;
  cancelOrder(input: CancelOrderInput): Promise<OrderResult>;
  getOrder(query: OrderQuery): Promise<OrderResult>;
  getOpenOrders(symbol?: string): Promise<OrderResult[]>;
  /** 订阅实时 K 线，返回取消订阅函数 */
  subscribeKlines(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle) => void,
  ): () => void;
  /**
   * 订阅高频实时价格，返回取消订阅函数。
   * 与 K 线流相互独立，任一路断开都不影响另一路。
   */
  subscribeTicker(symbol: string, onQuote: (quote: PriceQuote) => void): () => void;
}

export class ExchangeError extends Error {
  constructor(
    readonly exchange: ExchangeCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}
