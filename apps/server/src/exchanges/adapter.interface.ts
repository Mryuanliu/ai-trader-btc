import {
  Balance,
  Candle,
  Environment,
  ExchangeCode,
  KlineQuery,
  OrderSide,
  OrderStatus,
  OrderType,
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
