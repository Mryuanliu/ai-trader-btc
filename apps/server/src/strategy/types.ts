import type { Candle, LotDirection, LotExitReason } from '@ai-trader/shared';

/**
 * 策略运行时看到的仓位单（Lot）。
 *
 * 平台把交易所/本地记账的「每笔开仓订单」原样暴露给策略——
 * 策略据此判断第几层、均价多少、浮盈多少，自行决定加层或出场。
 */
export interface StrategyLotView {
  id: string;
  direction: LotDirection;
  /** 开仓数量 */
  quantity: number;
  entryPrice: number;
  /** 按当前价计的浮动盈亏（已扣开仓手续费） */
  unrealizedPnl: number;
  openedAt: string;
}

/** 策略运行时看到的挂单（未成交的 STOP / 限价单） */
export interface StrategyOrderView {
  id: string;
  side: 'BUY' | 'SELL';
  /** 交易所订单类型（STOP_MARKET / TAKE_PROFIT_MARKET / LIMIT …） */
  type: string;
  /** 触发价 / 委托价 */
  stopPrice: number;
  quantity: number;
  /** 交易所侧订单 ID，策略可用它撤单 */
  exchangeOrderId: string | null;
}

/**
 * 策略运行上下文（每个 tick 重新构造）。
 *
 * 只给「事实」不给「建议」：平台不做任何信号计算与风控判断，
 * 策略需要什么自己算（指标可以从 candles 自行计算）。
 */
export interface StrategyContext {
  symbol: string;
  /** 当前标记价 */
  price: number;
  /** ATR14：网格间距/手数缩放的通用波动率基准 */
  atr: number;
  /**
   * 最近 N 根 K 线（按时间升序，含未闭合的最后一根）。
   *
   * 平台只提供原始行情，**不预计算任何指标**——策略需要什么自己算
   * （指标是策略的一部分，不是平台的能力）。
   */
  candles: Candle[];
  /** 未完结仓位单（按开仓时间升序） */
  openLots: StrategyLotView[];
  /** 当前挂单 */
  openOrders: StrategyOrderView[];
  /** 可用保证金（USDT） */
  availableMargin: number;
  /** 净持仓数量（多头为正、空头为负） */
  netQty: number;
  /** 归一化后的策略参数（已合并默认值） */
  params: Record<string, unknown>;
  /** 当前时间戳（毫秒） */
  now: number;
}

/**
 * 开仓请求（策略 → 平台）。
 *
 * 不含止盈止损：出场完全由策略决定（马丁网格用篮子追踪止盈），
 * 平台不设也不扫描逐层 TP/SL。
 */
export interface OpenLotRequest {
  direction: LotDirection;
  quantity: number;
  /** 开仓原因（审计留痕） */
  reason: string;
}

/** 挂单请求（策略 → 平台）：EA 式网格靠 STOP 挂单实现 */
export interface PlaceStopOrderRequest {
  direction: LotDirection;
  /** STOP_MARKET：BUY 价格上破 stopPrice 触发 / SELL 价格下破触发 */
  stopPrice: number;
  quantity: number;
  /** 挂单用途标记，便于策略区分自己挂的网格单 */
  reason: string;
}

/**
 * 策略可用的交易能力。
 *
 * 所有下单都必须走这里（内部即平台的下单唯一出口），
 * 策略不得直接触碰交易所适配器——否则记账/成交对账会漏。
 */
export interface StrategyExecutor {
  /** 市价开仓，成功返回新建的 Lot id */
  openLot(input: OpenLotRequest): Promise<{ lotId: string | null; error?: string }>;
  /** 全量平掉指定仓位单（Lot 模型：不平部分） */
  closeLot(lotId: string, reason: LotExitReason): Promise<{ ok: boolean; error?: string }>;
  /** 挂 STOP 触发单（网格待成交层） */
  placeStopOrder(
    input: PlaceStopOrderRequest,
  ): Promise<{ orderId: string | null; error?: string }>;
  /** 撤销挂单 */
  cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 策略契约。
 *
 * 生命周期：`start` → 周期性 `onTick` → `stop`。
 * 策略是有状态对象，运行期间可持有自己的网格状态（层数、基准价等）。
 */
export interface TradingStrategy {
  /** 唯一标识 */
  readonly name: string;
  /** 展示名 */
  readonly label: string;
  readonly description: string;
  /** 默认参数 */
  readonly defaultParams: Record<string, unknown>;
  /** 参数 JSON Schema，供前端动态渲染表单 */
  readonly paramSchema: Record<string, unknown>;

  /** 校验并合并外部参数；非法值回落默认，策略永不因参数崩溃 */
  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown>;

  /** 启动钩子：重置内部状态（参数已归一化） */
  onStart?(params: Record<string, unknown>): void;
  /** 停止钩子：清空内部状态 */
  onStop?(): void;

  /** 每次 tick 调用：策略自行决定开仓/加层/平仓/挂单 */
  onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void>;

  /** 供前端展示的实时状态（网格层数、均价、浮盈等） */
  getState(): Record<string, unknown>;
}

/**
 * 策略的对外 DTO（列表描述 / 运行状态）定义在 shared，
 * 由前端与后端共用；这里直接透出，避免两处各写一份而漂移。
 */
export type { StrategyDescriptor, StrategyRunStatus } from '@ai-trader/shared';
