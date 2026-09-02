import {
  Balance,
  Candle,
  Environment,
  ExchangeCode,
  KlineQuery,
  MarginType,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
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
  /**
   * 持仓方向（仅合约有意义，现货适配器忽略）。
   * 单向持仓模式下为 LONG/SHORT，用于让交易所校验开平方向。
   */
  positionSide?: PositionSide;
  /** 只平仓单（反手信号的第一跳），仅合约有意义 */
  reduceOnly?: boolean;
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
  /**
   * 本次成交实际被收取的手续费，折算为 USDT。
   * 交易所不返回时（如下单响应用 RESULT 而非 FULL）为 undefined，
   * 调用方不得把它当成 0——0 意味着"确认免费"，undefined 才是"未知"。
   */
  fee?: number;
  feeAsset?: string;
  /** 交易所原始扣费数量与计价资产（现货买入扣基础币时用于净到账修正） */
  feeRaw?: number;
  feeAssetRaw?: string;
  raw?: unknown;
}

/** 手续费以这些资产计价时可直接当作 USDT，无需折算 */
const STABLE_FEE_ASSETS = new Set(['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'DAI']);

/**
 * 从下单响应的 fills[] 汇总手续费。
 *
 * 返回两组值：
 * - fee/feeAsset：折算为 USDT 的手续费（供盈亏计算，非稳定币按成交价折算）
 * - feeRaw/feeAssetRaw：交易所原始扣费（供净到账修正——
 *   币安现货买入手续费默认从买入的基础币里扣除，
 *   到账 = 下单量 − fee，quantity 若记全量会让本地推导持仓逐步虚增）
 *
 * 多笔 fill 计价资产混合时 feeRaw=0（无法安全修正，保守不动数量）。
 * 取不到 fills 时返回 undefined（表示未知），而非 0。
 */
export function sumCommissionUsdt(
  data: Record<string, any> | undefined | null,
  fallbackPrice: number,
): { fee: number; feeAsset: string; feeRaw: number; feeAssetRaw: string } | undefined {
  const fills = Array.isArray(data?.fills) ? (data.fills as Record<string, any>[]) : [];
  if (fills.length === 0) return undefined;

  let totalUsdt = 0;
  let rawTotal = 0;
  let rawAsset: string | null = null;
  let mixed = false;

  for (const f of fills) {
    const commission = Number(f?.commission ?? 0);
    if (!(commission > 0)) continue;
    const asset = String(f?.commissionAsset ?? 'USDT').toUpperCase();

    if (STABLE_FEE_ASSETS.has(asset)) {
      totalUsdt += commission;
    } else if (fallbackPrice > 0) {
      // 以基础币/BNB 等计价：按成交价折成 USDT，保持与持仓模型同币种
      totalUsdt += commission * fallbackPrice;
    }

    if (rawAsset === null) rawAsset = asset;
    else if (rawAsset !== asset) mixed = true;
    rawTotal += commission;
  }

  return {
    fee: totalUsdt,
    feeAsset: 'USDT',
    feeRaw: mixed ? 0 : rawTotal,
    feeAssetRaw: mixed ? 'USDT' : (rawAsset ?? 'USDT'),
  };
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
  /**
   * 是否具备下单能力。缺省视为 true。
   *
   * 只读适配器（如仅打通行情/账户阶段的合约适配器）须显式置 false，
   * 以便 ExchangeRegistry.getTradable() 将其排除，避免拿只读取器去下单。
   */
  readonly supportsTrading?: boolean;

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

/**
 * 合约交易所能力：在通用适配器之上追加杠杆与保证金模式设置。
 * 现货适配器不实现这些，执行器通过 isFuturesAdapter 做能力收窄。
 */
export type PositionMode = 'one-way' | 'hedge';

export interface FuturesExchangeAdapter extends ExchangeAdapter {
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setMarginType(symbol: string, marginType: MarginType): Promise<void>;
  /** 读取持仓模式（单向/双向） */
  getPositionMode?(): Promise<PositionMode>;
  /** 切换持仓模式；Lot 多空共存要求 hedge。可选：个别交易所不支持时由调用方降级 */
  setPositionMode?(dual: boolean): Promise<PositionMode>;
}

export function isFuturesAdapter(adapter: ExchangeAdapter): adapter is FuturesExchangeAdapter {
  const a = adapter as FuturesExchangeAdapter;
  return typeof a.setLeverage === 'function' && typeof a.setMarginType === 'function';
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
