import type {
  Candle,
  LotDirection,
  LotExitReason,
  StrategyManifest,
} from '@ai-trader/shared';

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
  /**
   * 已付开仓手续费（折 USDT）。
   * 供可观测层反推「币安口径毛浮盈」= unrealizedPnl + entryFeeUsdt（不含任何费的纯价差浮盈），
   * 让用户能把面板数字与币安持仓页直接对上。
   */
  entryFeeUsdt?: number;
  openedAt: string;
  /**
   * 该仓位单是否已有**在途平仓委托**（已下单、尚未成交回调）。
   *
   * 平仓从「下单」到「落库结算」之间有时间差，这段时间 Lot 仍是 OPEN。
   * 策略据此判断「出场是否已在进行中」，避免同一个 Lot 被平两次。
   */
  hasPendingClose: boolean;
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
  /**
   * 本次运行的**实例标识**（P2 多实例），`策略名:交易对`。
   *
   * 多实例下每个实例只看到自己的 Lot/挂单/篮子（buildContext 已过滤）；
   * 策略可用它做日志归因或实例级状态展示。
   */
  instanceId: string;
  /** 最新成交价（last price）：挂单触发、行情展示用这个 */
  price: number;
  /**
   * 交易所**标记价**（mark price）。
   *
   * 与 last price 的区别至关重要：标记价由现货指数 + 资金费基差平滑而来，
   * 不会被单笔大额成交「插针」扭曲。
   * - **强平/风控**口径一律用标记价（币安强平就是按标记价算）
   * - **止盈/止损判定也该用它**——用 last price 可能被一根插针误触发，
   *   导致刚赚到价就平、或刚亏损就止损
   * 标记价取不到时退化为 0，策略应回退用 price。
   */
  markPrice: number;
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
  /**
   * 杠杆覆盖。不传则用平台配置值。
   * 策略自己声明杠杆，避免「策略参数写着 5x、实际按配置 12x 下单」这类不一致。
   */
  leverage?: number;
  /** 开仓原因（审计留痕） */
  reason: string;
}

/** 挂单请求（策略 → 平台）：EA 式网格靠 STOP 挂单实现 */
export interface PlaceStopOrderRequest {
  direction: LotDirection;
  /** STOP_MARKET：BUY 价格上破 stopPrice 触发 / SELL 价格下破触发 */
  stopPrice: number;
  quantity: number;
  /** 杠杆覆盖（不传用平台配置值） */
  leverage?: number;
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
/**
 * 清单与能力声明的**正式定义放在 shared**（`@ai-trader/shared` 的 strategy-sdk），
 * 因为它们是**对外 SDK 契约**——第三方策略作者只依赖 shared 就要能写完策略。
 *
 * 这里转出一份，避免各处 import 路径不一致。
 */
export type { StrategyCapabilities, StrategyManifest } from '@ai-trader/shared';

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
  /**
   * 上架元信息（能力声明 / 版本 / 风险提示）。
   *
   * 可选是为了兼容早期内部策略；P1 起新策略必须提供，
   * 否则 Hub 会拒绝加载（没有风险提示的策略不能上架）。
   */
  readonly manifest?: StrategyManifest;

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
