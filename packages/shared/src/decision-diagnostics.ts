// SignalContribution 归属 indicators/signals（信号打分领域），此处复用并再导出，避免重复定义
import type { SignalContribution } from './indicators/signals';

export type { SignalContribution };

/**
 * 阻塞原因码：把「为什么没开单/为什么没下单」结构化。
 *
 * 设计目标（借鉴 EasyQuant Blocking Reasons 体系）：
 * - 结构化：可枚举，而非自由文本
 * - 可聚合：能按 24h 统计 Top 原因，识别系统性阻塞
 * - 可定位：每条原因都能指向具体排查路径
 * - 可复用：同一套码同时服务回测 / paper / 生产
 *
 * 核心洞见：可解释性不是「讲得通」，是「查得快」。
 * 排障顺序：先看 Top 原因聚合，再看单条明细。
 */
export type BlockingReasonCode =
  // 数据层
  | 'NO_CANDLES' // K 线为空或不足 warmup
  | 'INDICATOR_NAN' // 关键指标为 NaN
  | 'STALE_DATA' // 数据不新鲜（末根 bar 时间戳过旧）
  // 信号层
  | 'SIGNAL_NONE' // 规则未触发（行情不满足，非错误）
  | 'SIGNAL_CONFLICT' // 信号严重分歧（多空票接近）
  // 决策层
  | 'BELOW_MIN_CONFIDENCE' // 达阈值但置信度不足
  | 'STRATEGY_FALLBACK' // 策略名不存在，已回退
  // 风控层
  | 'RISK_MIN_NOTIONAL' // 名义价值/最小下单量不足
  | 'RISK_MAX_ORDER_AMOUNT' // 单笔金额超过上限
  | 'RISK_MAX_DAILY_ORDERS' // 今日下单笔数达上限
  | 'RISK_DAILY_LOSS' // 今日亏损达上限
  | 'RISK_INSUFFICIENT_BALANCE' // 可用余额不足
  | 'RISK_MAX_EXPOSURE' // 持仓敞口超限
  | 'RISK_MARGIN' // 保证金不足
  | 'RISK_LIQUIDATION_DIST' // 强平距离不足
  | 'RISK_LEVERAGE_CLAMPED' // 杠杆被钳制
  | 'RISK_INTERVAL' // 下单间隔未到
  | 'RISK_DRAWDOWN' // 回撤熔断
  | 'RISK_CONFIRM_REQUIRED' // 实盘缺二次确认 Token
  // 执行层
  | 'BROKER_REJECTED' // 交易所拒单
  | 'ENGINE_ERROR'; // 运行时异常

/** 决策诊断信息（随策略输出透传，落库到 agent_decisions.diagnostics） */
export interface DecisionDiagnostics {
  /**
   * 阻塞原因码，**仅在不产生 BUY/SELL 或被拦截时有意义**。
   * 已正常触发交易时省略该字段（没有"阻塞"这回事），但仍可携带 contributions 供下钻归因。
   */
  code?: BlockingReasonCode;
  /** 距离触发还差多少（0~1）。例如阈值 0.85、当前 |score| 0.65 → gap 0.20 */
  gapToTrigger?: number;
  /** 当前综合倾向分值（-1~1） */
  score?: number;
  /** 触发所需阈值 */
  requiredScore?: number;
  /** 各信号贡献，用于定位「谁拖后腿」 */
  contributions?: SignalContribution[];
  /** 补充明细（自由文本，仅用于人工排查，不参与聚合） */
  detail?: string;
}

/**
 * 把 RiskVerdict.rejectedBy（风控层原因码）映射为 BlockingReasonCode。
 *
 * 为什么需要：策略产出的 `blockingReason` 只覆盖策略层（信号未达阈值等），
 * 而**风控拦截发生在策略之后**，二者是不同层级。若只看 blockingReason，
 * 会把「信号正常触发、但被风控拒单」误判成「信号没触发」——归因到错误的层，
 * 排障时南辕北辙（实测踩过：12 次 BUY 全被 MAX_ORDER_AMOUNT 拦截，
 * 面板却只显示 SIGNAL_NONE）。
 *
 * 诊断聚合时应取 COALESCE(blockingReason, mapRiskRejectToBlockingCode(riskRejectedBy))。
 */
export function mapRiskRejectToBlockingCode(rejectedBy?: string | null): BlockingReasonCode | null {
  if (!rejectedBy) return null;
  const map: Record<string, BlockingReasonCode> = {
    MIN_ORDER_INTERVAL: 'RISK_INTERVAL',
    MAX_ORDER_AMOUNT: 'RISK_MAX_ORDER_AMOUNT',
    MAX_DAILY_ORDERS: 'RISK_MAX_DAILY_ORDERS',
    DAILY_LOSS_LIMIT: 'RISK_DAILY_LOSS',
    MAX_DRAWDOWN: 'RISK_DRAWDOWN',
    INSUFFICIENT_BALANCE: 'RISK_INSUFFICIENT_BALANCE',
    MAX_EXPOSURE: 'RISK_MAX_EXPOSURE',
    LIVE_MODE_CONFIRM_REQUIRED: 'RISK_CONFIRM_REQUIRED',
    INVALID_QUANTITY: 'RISK_MIN_NOTIONAL',
    // 引擎层（非 RiskService）：置信度不足 / 数量不足最小单位 / 无有效价格
    MIN_CONFIDENCE: 'BELOW_MIN_CONFIDENCE',
    MIN_QTY: 'RISK_MIN_NOTIONAL',
    NO_PRICE: 'STALE_DATA',
    // 合约风控
    RISK_MARGIN: 'RISK_MARGIN',
    LIQUIDATION_DIST: 'RISK_LIQUIDATION_DIST',
    LEVERAGE_CLAMPED: 'RISK_LEVERAGE_CLAMPED',
    BROKER_REJECTED: 'BROKER_REJECTED',
  };
  return map[rejectedBy] ?? null;
}

/**
 * 计算距离触发的差距。
 * 注：逐信号贡献度请用 indicators/signals 的 scoreSignalsDetailed()，避免重复实现。
 *
 *
 * @param score 当前综合倾向（-1~1）
 * @param threshold 触发阈值（正数，如 0.85）
 * @returns 差距 0~1；已触发时为 0
 */
export function gapToTrigger(score: number, threshold: number): number {
  const abs = Math.abs(score);
  const t = Math.abs(threshold);
  if (t <= 0) return 0;
  return Number(Math.max(0, Math.min(1, (t - abs) / t)).toFixed(4));
}

/**
 * 接近度：已达到触发所需的百分比（0~1）。
 * proximity=0.76 表示「已达到触发所需的 76%，还差 24%」。
 *
 * 与 gapToTrigger 互补：proximity = 1 - gap。
 */
export function proximityToTrigger(score: number, threshold: number): number {
  return Number((1 - gapToTrigger(score, threshold)).toFixed(3));
}
