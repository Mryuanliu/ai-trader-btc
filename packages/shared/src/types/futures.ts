import { floorToStep } from './common';
import type { LotDirection } from '../position';
import type { DecisionAction, MarketType, OrderSide, RunMode } from './common';

/** 持仓方向：LONG=多头，SHORT=空头 */
export const POSITION_SIDES = ['LONG', 'SHORT'] as const;
export type PositionSide = (typeof POSITION_SIDES)[number];

export const POSITION_SIDE_LABELS: Record<PositionSide, string> = {
  LONG: '多头',
  SHORT: '空头',
};

/** 保证金模式：逐仓（单仓风险隔离）/ 全仓（账户内风险共担） */
export const MARGIN_TYPES = ['isolated', 'cross'] as const;
export type MarginType = (typeof MARGIN_TYPES)[number];

export const MARGIN_TYPE_LABELS: Record<MarginType, string> = {
  isolated: '逐仓',
  cross: '全仓',
};

/**
 * 合约下单意图：把策略输出的 BUY/SELL 翻译成合约的方向语义。
 *
 * 这是「现货语义 → 合约语义」的唯一映射点，做成纯函数以便单测回溯：
 * 策略层完全不知道杠杆与多空，合约侧的差异全部收敛在这里。
 */
export type FuturesOrderIntent =
  /** 观望，不产生订单 */
  | { kind: 'hold'; reason: string }
  /** 无持仓时开仓：BUY=开多，SELL=开空 */
  | { kind: 'open'; side: OrderSide; positionSide: PositionSide; reduceOnly: false }
  /** 同方向加仓 */
  | { kind: 'add'; side: OrderSide; positionSide: PositionSide; reduceOnly: false }
  /** 反手信号：先只平仓（reduceOnly），反手留到下一周期无持仓时再开，避免单次误判放大风险 */
  | { kind: 'close'; side: OrderSide; positionSide: PositionSide; reduceOnly: true };

// 注：`resolveFuturesOrderIntent(action, currentQty)`（净持仓语义）已移除。
// 它依赖「HOLD 不动作、反向信号先平后开」的决策引擎前提；策略托管后
// 策略直接指定方向，合约侧只剩 Lot 语义的 resolveFuturesOrderIntentLot。

/**
 * 该意图是否会产生真实下单（hold 不产生）。
 * 写成类型守卫，让调用方在 `if` 之后能直接访问 side/positionSide，无需断言。
 */
export function isActionableIntent(
  intent: FuturesOrderIntent,
): intent is Exclude<FuturesOrderIntent, { kind: 'hold' }> {
  return intent.kind !== 'hold';
}

// 注：`isHoldIntent` 已移除（无消费者；hold 分支用判别式 intent.kind === 'hold' 即可）

// ---------------------------------------------------------------------------
// Position Lot（hedge mode）语义
// ---------------------------------------------------------------------------
// 用户拍板（2026-08-31）：合约 BUY=开多、SELL=开空，每单独立止盈止损，
// 多空 Lot 共存（锁仓）。反向信号不再平仓——出场只有两条路：
// 逐 Lot TP/SL 触发（checkLotExit）或手动平仓（指定 lotId 全量平掉）。

// 注：`MAX_OPEN_LOTS_PER_DIRECTION`（每方向 Lot 上限 3）已移除——
// 它是决策引擎的全局约束；策略托管后层数上限由策略参数自己定
//（马丁网格为 maxLayersPerSide，默认 6）。

/**
 * Lot 模型下的意图解析：动作只决定开仓方向，与当前净持仓无关。
 *
 * 与 resolveFuturesOrderIntent（净持仓语义）的区别：
 * 不再看 currentQty 判断开/加/平——同一动作永远开新 Lot，
 * 加仓=多一个 Lot，锁仓=多空 Lot 并存。旧函数保留给回测对照与切换前的历史语义。
 */
export function resolveFuturesOrderIntentLot(action: DecisionAction): FuturesOrderIntent {
  if (action === 'HOLD') {
    return { kind: 'hold', reason: '策略输出观望' };
  }
  return action === 'BUY'
    ? { kind: 'open', side: 'BUY', positionSide: 'LONG', reduceOnly: false }
    : { kind: 'open', side: 'SELL', positionSide: 'SHORT', reduceOnly: false };
}

/** 由 Lot 方向推导平仓意图：对冲该方向，全量 reduceOnly 平掉 */
export function resolveLotCloseIntent(direction: LotDirection): FuturesOrderIntent {
  return direction === 'LONG'
    ? { kind: 'close', side: 'SELL', positionSide: 'LONG', reduceOnly: true }
    : { kind: 'close', side: 'BUY', positionSide: 'SHORT', reduceOnly: true };
}

export interface FuturesSizingInput {
  /** 合约账户可用保证金（USDT） */
  availableMargin: number;
  /** 本次开仓占用的保证金比例 0~1 */
  positionPct: number;
  /** 杠杆倍数 */
  leverage: number;
  /** 参考价格（市价） */
  price: number;
  /** 交易所数量步进，用于向下取整 */
  stepSize: number;
}

export interface FuturesSizingResult {
  /** 取整后的下单数量，0 表示算不出合法数量 */
  quantity: number;
  /** 名义价值 = quantity × price */
  notional: number;
  /** 占用保证金 = notional / leverage */
  margin: number;
  /** 计算被拒绝的原因（数量为 0 时给出） */
  note?: string;
}

/**
 * 按「保证金预算 × 杠杆」推导开仓数量。
 *
 * 保证金 = 可用保证金 × positionPct（positionPct 是**保证金**占用比例，不是名义价值比例）
 * 名义价值 = 保证金 × 杠杆
 * 数量 = 名义价值 / 价格，再按 stepSize 向下取整（避免超出保证金预算）
 */
export function computeFuturesOrderQty(input: FuturesSizingInput): FuturesSizingResult {
  const { availableMargin, positionPct, leverage, price, stepSize } = input;

  if (!(availableMargin > 0)) {
    return { quantity: 0, notional: 0, margin: 0, note: '合约账户无可用保证金' };
  }
  if (!(positionPct > 0)) {
    return { quantity: 0, notional: 0, margin: 0, note: 'positionPct 必须大于 0' };
  }
  if (!(leverage > 0)) {
    return { quantity: 0, notional: 0, margin: 0, note: '杠杆倍数必须大于 0' };
  }
  if (!(price > 0)) {
    return { quantity: 0, notional: 0, margin: 0, note: '参考价格非法' };
  }
  if (!(stepSize > 0)) {
    return { quantity: 0, notional: 0, margin: 0, note: '数量步进非法' };
  }

  const margin = availableMargin * positionPct;
  const notional = margin * leverage;
  const quantity = floorToStep(notional / price, stepSize);

  if (!(quantity > 0)) {
    return {
      quantity: 0,
      notional: 0,
      margin,
      note: `开仓数量取整后为 0（名义 ${notional.toFixed(2)} / 价格 ${price}）`,
    };
  }

  // 取整后回落实际的名义与保证金，风控据此复核
  return { quantity, notional: quantity * price, margin: (quantity * price) / leverage };
}

// 注：`FUTURES_RISK_REASONS`（风控拒绝码）已移除——平台不做风控，
// 下单失败统一由交易所错误与前置校验（最小名义/数量精度）表达。

/**
 * 合约链路配置。
 *
 * 策略托管平台定位下，这里只保留**平台自身需要**的东西：
 * 账户与交易的基本参数。策略参数、链路选择、置信度阈值、杠杆上限、
 * 强平距离、出场规则等全部移除——它们是策略的内部事务，由策略自己管。
 */
export interface FuturesAgentConfigShape {
  /** 合约链路开关 */
  enabled: boolean;
  symbol: string;
  mode: RunMode;
  /** 保证金占用比例 0~1（平台按此推导下单数量） */
  positionPct: number;
  /** 开仓杠杆 */
  leverage: number;
  /** 保证金模式，默认逐仓（单仓风险隔离） */
  marginType: MarginType;
  /** 最近一次运行时间（ISO 字符串）；尚未运行过为 null */
  lastRunAt: string | null;
}

export const DEFAULT_FUTURES_AGENT_CONFIG: FuturesAgentConfigShape = {
  enabled: true,
  symbol: 'BTCUSDT',
  mode: 'dry_run',
  positionPct: 0.1,
  // 默认 5 倍：杠杆是双刃剑，5 倍下约 20% 反向波动即爆仓。
  // 平台不设上限——用多少由策略自己决定（定位是策略托管平台）。
  leverage: 5,
  marginType: 'isolated',
  lastRunAt: null,
};

/** 合约持仓视图（供前端展示；以交易所 positionRisk 为权威） */
export interface FuturesPositionView {
  symbol: string;
  market: MarketType;
  quantity: number;
  positionSide: PositionSide | null;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  marginType: MarginType;
  isolatedMargin: number;
  unrealizedPnl: number;
  notional: number;
  liquidationDistancePct: number | null;
}
