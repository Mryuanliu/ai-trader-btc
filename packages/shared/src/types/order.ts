import type {
  Environment,
  ExchangeCode,
  MarketType,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
  RunMode,
} from './common';

/**
 * 订单视图（前后端共用）。
 *
 * 原文件为 `types/agent.ts`——决策引擎移除后，那里只剩这一个类型
 * 还是活的（其余 Signal / DecisionRecord / ExitRulesShape 等已全删），
 * 故改名为 `order.ts` 以名实相符。
 */
export interface OrderDTO {
  id: string;
  exchange: ExchangeCode;
  environment: Environment;
  mode: RunMode;
  /** 市场：现货/合约 */
  market: MarketType;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  /** 条件单触发价（STOP_MARKET / TAKE_PROFIT_MARKET）；市价与限价单为 0 */
  stopPrice: number;
  quantity: number;
  quoteAmount: number;
  status: OrderStatus;
  filledQuantity: number;
  filledPrice: number;
  exchangeOrderId: string | null;
  source: OrderSource;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
