import type {
  DecisionAction,
  ExchangeCode,
  MarketType,
  OrderSource,
  OrderType,
  SymbolFilters,
} from './common';
import type {
  DecisionLane,
  DecisionRiskVerdict,
  StrategyName,
} from './agent';
import type { MarginType, PositionSide } from './futures';
import { floorToStep } from './common';

/**
 * 跨市场执行器契约（L4 执行层的可插拔抽象）。
 *
 * 架构定位：L0~L3（数据/上下文/信号/策略）现货与合约完全共用，
 * L4~L6（执行/风控/持仓）各自实现，通过本接口统一收口。
 * 新增市场（如期权）只需实现本接口并注册，无需改动任何上层调度代码。
 *
 * 关键约定：**入参是策略语义的 BUY/SELL/HOLD，不是交易所语义的买卖方向**。
 * "BUY 到底是开多还是平空" 由各执行器结合自身持仓决定，
 * 上层决策链路因此完全不需要知道市场差异。
 */
export interface MarketExecutor {
  /** 市场类型 */
  readonly market: MarketType;
  /** 该市场对应的交易所 code */
  readonly exchange: ExchangeCode;

  /**
   * 可用资金：现货=该资产可用余额；合约=可用保证金（USDT）。
   * 不传资产时返回该市场的默认计价资产。
   */
  getAvailable(asset?: string): Promise<number>;

  /** 当前持仓（现货非负、合约可负） */
  getPosition(symbol: string): Promise<ExecutorPositionView>;

  /** 交易对过滤器（步进、最小名义等） */
  getFilters(symbol: string): Promise<SymbolFilters>;

  /**
   * 执行决策：把策略动作翻译成该市场的订单并发单。
   * HOLD 或下单量不足时返回 order=null，不抛异常。
   */
  placeOrder(input: ExecOrderInput): Promise<ExecResult>;
}

/** 执行器下单入参：统一为策略语义 */
export interface ExecOrderInput {
  symbol: string;
  /** 策略输出的动作，由执行器翻译为各市场语义 */
  action: DecisionAction;
  type?: OrderType;
  /** 限价单价格；市价单忽略 */
  price?: number;
  source: OrderSource;
  decisionId?: string | null;
  /** 实盘二次确认 Token */
  confirmToken?: string;
  /** 出场规则触发：卖出/平仓时用全部持仓而非 positionPct */
  closeAll?: boolean;
  /** hybrid 链路的 AI 仓位乘数（0.5~1.5），仅作用于开仓 */
  positionMultiplier?: number | null;
  /** 直接指定数量（手动单）；不传则按各市场规则推导 */
  quantity?: number;
}

export interface ExecResult {
  /** 未产生订单（观望或数量不足）时为 null */
  order: ExecOrderView | null;
  risk: DecisionRiskVerdict;
  /** 未下单时的原因，便于决策记录与前端展示 */
  note?: string;
  /** 各市场专属细节：合约返回杠杆/保证金/方向，现货返回空对象 */
  detail: ExecDetail;
}

/** 轻量化订单视图：只暴露跨市场通用字段，避免执行层耦合数据库实体 */
export interface ExecOrderView {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: OrderType;
  quantity: number;
  price: number;
  status: string;
  filledQuantity: number;
  filledPrice: number;
  exchangeOrderId: string | null;
  error: string | null;
}

/** 执行细节：合约专属字段，现货为 null */
export interface ExecDetail {
  /** 合约杠杆倍数；现货为 null */
  leverage: number | null;
  /** 合约持仓方向；现货为 null */
  positionSide: PositionSide | null;
  /** 是否只平仓单；现货为 null */
  reduceOnly: boolean | null;
  /** 合约占用保证金；现货为 null */
  margin: number | null;
  /** 合约名义价值；现货为 null */
  notional: number | null;
}

export const EMPTY_EXEC_DETAIL: ExecDetail = {
  leverage: null,
  positionSide: null,
  reduceOnly: null,
  margin: null,
  notional: null,
};

/** 跨市场持仓视图：现货与合约的差异字段以 null 表达，便于前端统一渲染 */
export interface ExecutorPositionView {
  symbol: string;
  market: MarketType;
  /** 净持仓：现货非负，合约正=多头、负=空头 */
  quantity: number;
  /** 持仓方向；现货无方向概念时为 null */
  side: PositionSide | null;
  /** 现货=成本均价，合约=开仓均价 */
  entryPrice: number;
  /** 当前市值（现货）/ 名义价值（合约） */
  marketValue: number;
  unrealizedPnl: number;
  /** 合约强平价；现货为 null */
  liquidationPrice: number | null;
  /** 合约杠杆；现货为 null */
  leverage: number | null;
  /** 合约保证金模式；现货为 null */
  marginType: MarginType | null;
  /** 距强平价百分比；现货为 null */
  liquidationDistancePct: number | null;
}

/** 各市场 Agent 配置的公共部分，供上层按市场取用 */
export interface ExecutorConfigRef {
  lane: DecisionLane;
  strategyName: StrategyName;
  symbol: string;
  timeframe: string;
  positionPct: number;
  minConfidence: number;
}
