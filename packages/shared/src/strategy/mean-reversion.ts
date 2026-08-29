import type { Strategy, StrategyContext, StrategyOutput } from './types';

/**
 * 均值回归策略：价格极端偏离均价时反向出手，等待回归。
 *
 * 入场采用「双条件确认」（价格触及布林极值区 + RSI 超买超卖），
 * 缺一不出手——单条件触发的假信号太多。置信度由偏离深度单调映射，
 * 触发即通过 minConfidence（与 trend_following 同样无死区）。
 *
 * 注意：均值回归与趋势跟踪是相反方向的赌注，参数调不出来，只能换策略。
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = 'mean_reversion';
  readonly label = '均值回归';
  readonly description =
    '布林带极值 + RSI 超买超卖双条件确认，价格极端偏离均价时反向出手，回归至中性区间前持有。';

  readonly defaultParams = {
    /** RSI 超卖阈值（<= 视为超卖） */
    rsiOversold: 30,
    /** RSI 超买阈值（>= 视为超买） */
    rsiOverbought: 70,
    /** 布林带位置下界：%b <= 该值视为触及下轨区 */
    bandPosLow: 0.05,
    /** 布林带位置上界：%b >= 该值视为触及上轨区 */
    bandPosHigh: 0.95,
    /** 触发时的置信度起点（需 >= 引擎 minConfidence） */
    confidenceFloor: 0.6,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      rsiOversold: { type: 'number', minimum: 0, maximum: 100, title: 'RSI 超卖阈值' },
      rsiOverbought: { type: 'number', minimum: 0, maximum: 100, title: 'RSI 超买阈值' },
      bandPosLow: { type: 'number', minimum: 0, maximum: 1, title: '布林下轨区 %b' },
      bandPosHigh: { type: 'number', minimum: 0, maximum: 1, title: '布林上轨区 %b' },
      confidenceFloor: { type: 'number', minimum: 0, maximum: 1, title: '触发时置信度起点' },
    },
  };

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const num = (value: unknown, fallback: number, min: number, max: number): number => {
      if (value === null || value === undefined || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    return {
      rsiOversold: num(raw?.rsiOversold, this.defaultParams.rsiOversold, 0, 100),
      rsiOverbought: num(raw?.rsiOverbought, this.defaultParams.rsiOverbought, 0, 100),
      bandPosLow: num(raw?.bandPosLow, this.defaultParams.bandPosLow, 0, 1),
      bandPosHigh: num(raw?.bandPosHigh, this.defaultParams.bandPosHigh, 0, 1),
      confidenceFloor: num(raw?.confidenceFloor, this.defaultParams.confidenceFloor, 0, 1),
    };
  }

  evaluate(ctx: StrategyContext): StrategyOutput {
    const p = this.mergedParams(ctx.params);
    const { rsi14, bollUpper, bollLower, lastClose } = ctx.indicators;

    // 指标不足（样本 < 布林周期等）→ 不出手
    if (
      Number.isNaN(rsi14) ||
      Number.isNaN(bollUpper) ||
      Number.isNaN(bollLower) ||
      !(bollUpper > bollLower) ||
      !(lastClose > 0)
    ) {
      return this.hold('指标样本不足或带宽为 0，观望');
    }

    const bandPos = (lastClose - bollLower) / (bollUpper - bollLower);

    // 超卖 → BUY：价格触及下轨区 且 RSI 超卖，双条件同时满足
    if (bandPos <= p.bandPosLow && rsi14 <= p.rsiOversold) {
      const bandScore = clamp01((p.bandPosLow - bandPos) / Math.max(1e-9, p.bandPosLow));
      const rsiScore = clamp01((p.rsiOversold - rsi14) / Math.max(1e-9, p.rsiOversold));
      const strength = (bandScore + rsiScore) / 2;
      const confidence = toConfidence(p.confidenceFloor, strength);
      return {
        action: 'BUY',
        confidence,
        reason:
          `均值回归买入：%b ${bandPos.toFixed(3)} 触及下轨区（<=${p.bandPosLow}）且 ` +
          `RSI ${rsi14.toFixed(1)} 超卖（<=${p.rsiOversold}），价格极端偏离均价。`,
        riskNotes: '逆向出手，若下跌为趋势开端而非超跌，将逆势接刀；建议配合出场规则止损。',
      };
    }

    // 超买 → SELL：价格触及上轨区 且 RSI 超买
    if (bandPos >= p.bandPosHigh && rsi14 >= p.rsiOverbought) {
      const bandScore = clamp01((bandPos - p.bandPosHigh) / Math.max(1e-9, 1 - p.bandPosHigh));
      const rsiScore = clamp01((rsi14 - p.rsiOverbought) / Math.max(1e-9, 100 - p.rsiOverbought));
      const strength = (bandScore + rsiScore) / 2;
      const confidence = toConfidence(p.confidenceFloor, strength);
      return {
        action: 'SELL',
        confidence,
        reason:
          `均值回归卖出：%b ${bandPos.toFixed(3)} 触及上轨区（>=${p.bandPosHigh}）且 ` +
          `RSI ${rsi14.toFixed(1)} 超买（>=${p.rsiOverbought}），价格极端偏离均价。`,
        riskNotes: '逆向出手，若上涨为趋势开端而非超买，将过早离场。',
      };
    }

    return this.hold(
      `%b ${bandPos.toFixed(3)}、RSI ${rsi14.toFixed(1)} 处于中性区间，无极端偏离`,
    );
  }

  private hold(note: string): StrategyOutput {
    return {
      action: 'HOLD',
      confidence: 0,
      reason: `按 mean_reversion 指标信号执行：${note}。`,
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
    };
  }

  /** evaluate 内的参数兜底：即使调用方绕过 normalizeParams 传入脏 params 也不崩溃 */
  private mergedParams(params: Record<string, unknown>) {
    const merged = this.normalizeParams({ ...this.defaultParams, ...params });
    return merged as unknown as {
      rsiOversold: number;
      rsiOverbought: number;
      bandPosLow: number;
      bandPosHigh: number;
      confidenceFloor: number;
    };
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 置信度映射：触发即 >= floor（无死区），强度 1 时达到 1.0 */
function toConfidence(floor: number, strength: number): number {
  return Number((floor + (1 - floor) * clamp01(strength)).toFixed(2));
}
