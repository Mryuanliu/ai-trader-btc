import type { Strategy, StrategyContext, StrategyOutput } from './types';

/**
 * 趋势跟踪策略：六信号（MA 排列/RSI/MACD/布林带/量能/中期均线）加权合成倾向，
 * 越过阈值出手。逻辑迁移自原 AgentEngine.fallbackDecision()，阶段 1 保持行为一致
 * （缺陷修复在阶段 3、于回测验证下进行）。
 */
export class TrendFollowingStrategy implements Strategy {
  readonly name = 'trend_following';
  readonly label = '趋势跟踪';
  readonly description =
    '六信号加权：MA 多空排列 / RSI / MACD / 布林带位置 / 量能 / 中期均线，综合倾向越过阈值时顺势出手。';

  readonly defaultParams = {
    /** 开仓阈值：|综合倾向| 达到该值才产生 BUY/SELL */
    entryThreshold: 0.25,
    /** 置信度下限（score=0 时） */
    confidenceBase: 0.45,
    /** 置信度跨度（|score|=1 时达到 base + span） */
    confidenceSpan: 0.4,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      entryThreshold: { type: 'number', minimum: 0, maximum: 1, title: '开仓阈值' },
      confidenceBase: { type: 'number', minimum: 0, maximum: 1, title: '置信度下限' },
      confidenceSpan: { type: 'number', minimum: 0, maximum: 1, title: '置信度跨度' },
    },
  };

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const num = (value: unknown, fallback: number, min: number, max: number): number => {
      // null/undefined/'' 经 Number() 会变 0，必须显式视为非法
      if (value === null || value === undefined || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    return {
      entryThreshold: num(raw?.entryThreshold, this.defaultParams.entryThreshold, 0, 1),
      confidenceBase: num(raw?.confidenceBase, this.defaultParams.confidenceBase, 0, 1),
      confidenceSpan: num(raw?.confidenceSpan, this.defaultParams.confidenceSpan, 0, 1),
    };
  }

  evaluate(ctx: StrategyContext): StrategyOutput {
    const { entryThreshold, confidenceBase, confidenceSpan } = this.mergedParams(ctx.params);
    const score = ctx.indicatorScore;
    const magnitude = Math.min(1, Math.abs(score));

    let action: StrategyOutput['action'] = 'HOLD';
    if (score >= entryThreshold) action = 'BUY';
    else if (score <= -entryThreshold) action = 'SELL';

    const direction = score > 0 ? '偏多' : score < 0 ? '偏空' : '中性';
    return {
      action,
      confidence: Number((confidenceBase + magnitude * confidenceSpan).toFixed(2)),
      reason:
        `按 trend_following 指标信号执行：综合倾向 ${score.toFixed(2)}（${direction}），` +
        `采用 MA/RSI/MACD/布林带加权结果。`,
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
    };
  }

  /** evaluate 内的参数兜底：即使调用方绕过 normalizeParams 传入脏 params 也不崩溃 */
  private mergedParams(params: Record<string, unknown>) {
    const merged = this.normalizeParams({ ...this.defaultParams, ...params });
    return {
      entryThreshold: merged.entryThreshold as number,
      confidenceBase: merged.confidenceBase as number,
      confidenceSpan: merged.confidenceSpan as number,
    };
  }
}
