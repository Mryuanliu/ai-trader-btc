import type { StrategyName } from '../types/agent';
import { DEFAULT_LOT_STOP_LOSS_PCT, DEFAULT_LOT_TAKE_PROFIT_PCT } from '../position';

/**
 * 阶段 5 · AI 上下文层（分层裁决）的 AI 输出契约。
 *
 * AI 不输出买卖指令，只输出「元参数」——对市场状态的定性判断，
 * 由确定性映射函数转换为策略参数。这样：
 * - 决策本体仍由策略产出（可回测、可复现）
 * - AI 的不可回测性被隔离在「regime 判断」一个点上
 * - 亏损可归因：是 AI 判断错市场状态，还是策略执行有问题
 */
export interface ContextInsight {
  /** 市场状态：trending=趋势市（顺势策略友好）；ranging=震荡市（均值回归友好）；volatile=高波动风险市 */
  regime: 'trending' | 'ranging' | 'volatile';
  /** 市场状态置信度 0~1；低于 regimeConfidenceFloor 时视为判断不可靠，用中性参数 */
  regimeConfidence: number;
  /** 激进度 0~1：0=极保守（缩小仓位、抬高门槛），1=激进（放大仓位、降低门槛） */
  aggression: number;
  /** 新闻情绪 -1~1：负面为负。仅作为门槛微调，不直接触发买卖 */
  newsSentiment: number;
  /** 对当前持仓的定性评估 */
  positionView: 'positive' | 'neutral' | 'negative';
  /** 不超过 80 字的判断说明（写入决策理由） */
  comment: string;
  /**
   * 建议止损比例（0.005~0.1，可选）。
   * Lot 模型下 hybrid 链路的 AI 按市场状态逐单给止盈止损（用户拍板）；
   * 不输出或非法时由引擎回落全局兜底（SL 2%/TP 4%）。
   */
  suggestedStopLossPct?: number;
  /** 建议止盈比例（0.005~0.1，可选） */
  suggestedTakeProfitPct?: number;
}

/** AI 中性默认输出：AI 挂掉/TTL 过期时策略用这套参数继续运行，不停摆 */
export const NEUTRAL_CONTEXT_INSIGHT: ContextInsight = {
  regime: 'trending',
  regimeConfidence: 0,
  aggression: 0.5,
  newsSentiment: 0,
  positionView: 'neutral',
  comment: 'AI 上下文不可用，使用中性默认参数继续运行',
};

/** 映射后的策略参数调整量（叠加在 strategyParams 之上） */
export interface MappedStrategyParams {
  entryThreshold?: number;
  confidenceFloor?: number;
  /** 仓位乘数（作用于实盘 positionPct；回测引擎按 minConfidence 之外的仓位口径独立处理） */
  positionMultiplier: number;
}

/** trend_following 的默认入场阈值（与其 defaultParams 保持一致） */
const TREND_FOLLOWING_DEFAULT_THRESHOLD = 0.85;

/** 映射后的入场阈值安全区间，防止 AI 输出把门槛推到失效或滥触发 */
const ENTRY_THRESHOLD_MIN = 0.3;
const ENTRY_THRESHOLD_MAX = 0.95;

/**
 * 元参数 → 策略参数映射（纯函数，可离线回放验证）。
 *
 * 设计要点（计划 §2.4.8）：
 * - 以「参数调节」为主（连续平滑，无策略切换抖动）
 * - regime 判断只在「高置信度」时才轻微影响门槛（A 为辅）
 * - 新闻情绪极端负面时抬门槛（C 兜底的温和形态），不一票否决
 *
 * @param currentParams 当前生效的策略参数（用户 strategyParams 与策略默认值合并后），
 *   用于取入场阈值基准；偏移叠加在基准之上输出绝对值，未提供基准时用策略默认值。
 */
export function mapInsightToParams(
  insight: ContextInsight,
  strategyName: StrategyName = 'trend_following',
  currentParams?: Record<string, unknown>,
): MappedStrategyParams {
  const { regime, regimeConfidence, aggression, newsSentiment } = insight;

  // 激进度 → 仓位乘数：0.5 为中性 1.0，线性映射到 [0.5, 1.5]
  const positionMultiplier = 0.5 + aggression;

  // 激进度 → 门槛偏移：越激进门槛越低（±0.1 内）
  const thresholdShift = (0.5 - aggression) * 0.2;

  // 新闻情绪 → 门槛微调：极端负面（<-0.5）抬门槛 0.05，正面不降门槛（非对称，保守优先）
  const sentimentShift = newsSentiment < -0.5 ? 0.05 : 0;

  // regime → 门槛调整（仅高置信度时生效）：volatile 抬门槛避险
  let regimeShift = 0;
  if (regimeConfidence >= REGIME_CONFIDENCE_FLOOR) {
    if (regime === 'volatile') regimeShift = 0.1;
    else if (regime === 'ranging' && strategyName === 'trend_following') regimeShift = 0.05;
  }

  const entryThreshold =
    strategyName === 'trend_following'
      ? clamp(
          Number(currentParams?.entryThreshold ?? TREND_FOLLOWING_DEFAULT_THRESHOLD) +
            thresholdShift +
            sentimentShift +
            regimeShift,
          ENTRY_THRESHOLD_MIN,
          ENTRY_THRESHOLD_MAX,
        )
      : undefined;

  // 只返回真正生效的键：显式 undefined 会覆盖用户 strategyParams 里的同名配置
  const mapped: MappedStrategyParams = { positionMultiplier: round4(positionMultiplier) };
  if (entryThreshold !== undefined) mapped.entryThreshold = round4(entryThreshold);
  return mapped;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** regime 判断被认为可靠所需的最低置信度 */
export const REGIME_CONFIDENCE_FLOOR = 0.6;

/** 校验并钳制 AI 输出：字段缺失/越界回落中性，AI 输出永不使映射崩溃 */
export function normalizeInsight(raw: unknown): ContextInsight {
  if (raw == null || typeof raw !== 'object') return { ...NEUTRAL_CONTEXT_INSIGHT };
  const obj = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  };
  const regime = obj.regime === 'ranging' || obj.regime === 'volatile' ? obj.regime : 'trending';
  const result: ContextInsight = {
    regime,
    regimeConfidence: num(obj.regimeConfidence, 0, 0, 1),
    aggression: num(obj.aggression, 0.5, 0, 1),
    newsSentiment: num(obj.newsSentiment, 0, -1, 1),
    positionView:
      obj.positionView === 'positive' || obj.positionView === 'negative'
        ? obj.positionView
        : 'neutral',
    comment: typeof obj.comment === 'string' && obj.comment.trim() ? obj.comment.slice(0, 80) : '',
  };
  // TP/SL 建议为可选输出：缺失/非法时保持 undefined，由引擎用全局兜底
  const rawSl = obj.suggestedStopLossPct;
  const rawTp = obj.suggestedTakeProfitPct;
  if (typeof rawSl === 'number' && Number.isFinite(rawSl) && rawSl > 0) {
    result.suggestedStopLossPct = rawSl;
  }
  if (typeof rawTp === 'number' && Number.isFinite(rawTp) && rawTp > 0) {
    result.suggestedTakeProfitPct = rawTp;
  }
  return result;
}

/**
 * 从 AI 上下文提取逐单 TP/SL（hybrid 链路专用），并钳制到安全区间。
 * AI 未输出或 strategy 链路（无 insight）返回 null → 调用方用全局兜底。
 */
export function extractLotTpSl(
  insight: ContextInsight | null | undefined,
): { stopLossPct: number; takeProfitPct: number } | null {
  if (!insight) return null;
  const hasSl = typeof insight.suggestedStopLossPct === 'number' && insight.suggestedStopLossPct > 0;
  const hasTp =
    typeof insight.suggestedTakeProfitPct === 'number' && insight.suggestedTakeProfitPct > 0;
  if (!hasSl && !hasTp) return null;
  return {
    stopLossPct: hasSl ? (insight.suggestedStopLossPct as number) : DEFAULT_LOT_STOP_LOSS_PCT,
    takeProfitPct: hasTp ? (insight.suggestedTakeProfitPct as number) : DEFAULT_LOT_TAKE_PROFIT_PCT,
  };
}

function round4(v: number): number {
  return Number(v.toFixed(4));
}
