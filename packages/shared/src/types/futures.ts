import { floorToStep } from './common';
import type { LotDirection } from '../position';
import type {
  DecisionAction,
  MarketType,
  OrderSide,
  RunMode,
  Timeframe,
} from './common';
import type { DecisionLane, ExitRulesShape, StrategyName } from './agent';

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

/**
 * 由「策略动作 + 当前净持仓」推导合约下单意图。
 *
 * | 策略 | 无持仓 | 持多 | 持空 |
 * |---|---|---|---|
 * | BUY  | 开多   | 加多 | 平空（reduceOnly） |
 * | SELL | 开空   | 平多（reduceOnly） | 加空 |
 * | HOLD | 观望   | 观望 | 观望 |
 *
 * 反向信号只平仓不反手：平完后的下一个决策周期若信号仍然是反方向，
 * 此时持仓已为 0，会自然落到「开仓」分支。这样把「平+开」拆成两次决策，
 * 即便中间行情剧烈波动也不会在同一跳内留下双倍仓位。
 *
 * @param action 策略输出的动作
 * @param currentQty 当前净持仓：正=多头，负=空头，0=无持仓
 */
export function resolveFuturesOrderIntent(
  action: DecisionAction,
  currentQty: number,
): FuturesOrderIntent {
  if (action === 'HOLD') {
    return { kind: 'hold', reason: '策略输出观望' };
  }

  const held = Number(currentQty);
  const long = held > 0;
  const short = held < 0;

  if (action === 'BUY') {
    // 持空时买入 = 平空；其余为开多/加多
    if (short) return { kind: 'close', side: 'BUY', positionSide: 'SHORT', reduceOnly: true };
    return long
      ? { kind: 'add', side: 'BUY', positionSide: 'LONG', reduceOnly: false }
      : { kind: 'open', side: 'BUY', positionSide: 'LONG', reduceOnly: false };
  }

  // action === 'SELL'
  if (long) return { kind: 'close', side: 'SELL', positionSide: 'LONG', reduceOnly: true };
  return short
    ? { kind: 'add', side: 'SELL', positionSide: 'SHORT', reduceOnly: false }
    : { kind: 'open', side: 'SELL', positionSide: 'SHORT', reduceOnly: false };
}

/**
 * 该意图是否会产生真实下单（hold 不产生）。
 * 写成类型守卫，让调用方在 `if` 之后能直接访问 side/positionSide，无需断言。
 */
export function isActionableIntent(
  intent: FuturesOrderIntent,
): intent is Exclude<FuturesOrderIntent, { kind: 'hold' }> {
  return intent.kind !== 'hold';
}

/** 是否为观望意图（类型守卫，便于读取 reason） */
export function isHoldIntent(
  intent: FuturesOrderIntent,
): intent is Extract<FuturesOrderIntent, { kind: 'hold' }> {
  return intent.kind === 'hold';
}

// ---------------------------------------------------------------------------
// Position Lot（hedge mode）语义
// ---------------------------------------------------------------------------
// 用户拍板（2026-08-31）：合约 BUY=开多、SELL=开空，每单独立止盈止损，
// 多空 Lot 共存（锁仓）。反向信号不再平仓——出场只有两条路：
// 逐 Lot TP/SL 触发（checkLotExit）或手动平仓（指定 lotId 全量平掉）。

/** 每方向未完结 Lot 上限：超出时同向信号被忽略并记 blocking reason */
export const MAX_OPEN_LOTS_PER_DIRECTION = 3;

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

/** 合约风控拒绝码与文案 */
export const FUTURES_RISK_REASONS: Record<string, string> = {
  LEVERAGE_CLAMPED: '杠杆超出允许范围，已钳制',
  BELOW_MIN_NOTIONAL: '名义价值低于交易所最小名义',
  INSUFFICIENT_MARGIN: '可用保证金不足',
  LIQUIDATION_TOO_CLOSE: '距强平价过近，禁止加仓',
  LIVE_MODE_CONFIRM_REQUIRED: '实盘下单缺少二次确认 Token',
  INVALID_QUANTITY: '下单数量不合法',
  NO_POSITION_TO_CLOSE: '无持仓可平',
  ADAPTER_NOT_TRADABLE: '合约适配器不支持交易',
};

/** 合约 Agent 配置（独立链路，与现货 agent_configs 互不干扰） */
export interface FuturesAgentConfigShape {
  name: string;
  /** 合约链路开关（用户要求默认开启） */
  enabled: boolean;
  symbol: string;
  timeframe: Timeframe;
  decisionIntervalSec: number;
  mode: RunMode;
  /** 保证金占用比例 0~1 */
  positionPct: number;
  /** 触发下单的最低置信度 0~1 */
  minConfidence: number;
  /** 开仓杠杆，钳制 1~maxLeverage */
  leverage: number;
  /** 杠杆硬上限（管理员可配，默认 10） */
  maxLeverage: number;
  /** 保证金模式，默认逐仓（单仓风险隔离） */
  marginType: MarginType;
  /** 距强平价低于该比例时禁止加仓 */
  liquidationBufferPct: number;
  decisionLane: DecisionLane;
  strategyName: StrategyName;
  strategyParams: Record<string, unknown>;
  exitRules: ExitRulesShape;
  /** 最近一次运行时间（ISO 字符串）；尚未运行过为 null */
  lastRunAt: string | null;
}

export const DEFAULT_FUTURES_AGENT_CONFIG: FuturesAgentConfigShape = {
  name: 'BTC 合约 Agent',
  enabled: true,
  symbol: 'BTCUSDT',
  timeframe: '5m',
  decisionIntervalSec: 300,
  mode: 'dry_run',
  positionPct: 0.1,
  minConfidence: 0.6,
  // 默认 5 倍：方案拍板值。杠杆是双刃剑，5 倍下 20% 反向波动即爆仓，
  // 必须配合 maxLeverage 上限与强平距离预警一起用。
  leverage: 5,
  maxLeverage: 10,
  // 逐仓：单个仓位亏损不影响账户其他资金
  marginType: 'isolated',
  liquidationBufferPct: 0.15,
  decisionLane: 'hybrid',
  strategyName: 'trend_following',
  strategyParams: {},
  exitRules: { stopLossPct: null, takeProfitPct: null },
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
