import type { Strategy, StrategyContext, StrategyOutput } from './types';

/**
 * 趋势跟踪策略：六信号（MA 排列/RSI/MACD/布林带/量能/中期均线）加权合成倾向，
 * 越过阈值出手。阶段 3 已修复三个缺陷：
 * ① 死区——confidence 由「越过阈值后的信号强度」单调映射，起点即 confidenceFloor（默认 0.6），
 *    只要触发了阈值就必然通过 minConfidence 拦截，不再有「产生 BUY/SELL 却被置信度拦掉」的区间；
 * ② 归一化过度自信——scoreSignals 分母改为全部信号权重（见 indicators/signals.ts）；
 * ③ 量能信号失效——量能统计改用已闭合 K 线（见 indicators/signals.ts）。
 */
export class TrendFollowingStrategy implements Strategy {
  readonly name = 'trend_following';
  readonly label = '趋势跟踪';
  readonly description =
    '六信号加权：MA 多空排列 / RSI / MACD / 布林带位置 / 量能 / 中期均线，综合倾向越过阈值时顺势出手。';

  readonly defaultParams = {
    /**
     * 开仓阈值：|综合倾向| 达到该值才产生 BUY/SELL。
     * 默认 0.85 经双窗口回测校准（2026-07-01~08-20 与 08-20~08-29，5m）：
     * 阈值在 0.25→0.85 区间内绩效单调改善，低阈值被手续费拖垮（9 天 2026 笔、超额 -14.7%），
     * 0.85 时两窗口均为正收益（+1.15% / +1.67%）、回撤降至 2.7%~6.3%
     */
    entryThreshold: 0.85,
    /** 触发阈值时的置信度起点（需 >= 引擎 minConfidence，默认对齐 0.6） */
    confidenceFloor: 0.6,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      entryThreshold: { type: 'number', minimum: 0, maximum: 1, title: '开仓阈值' },
      confidenceFloor: { type: 'number', minimum: 0, maximum: 1, title: '触发时置信度起点' },
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
      confidenceFloor: num(raw?.confidenceFloor, this.defaultParams.confidenceFloor, 0, 1),
    };
  }

  evaluate(ctx: StrategyContext): StrategyOutput {
    const { entryThreshold, confidenceFloor } = this.mergedParams(ctx.params);
    const score = ctx.indicatorScore;

    let action: StrategyOutput['action'] = 'HOLD';
    if (score >= entryThreshold) action = 'BUY';
    else if (score <= -entryThreshold) action = 'SELL';

    // 缺陷①修复：置信度只由「越过阈值的幅度」映射，触发即 >= confidenceFloor，
    // 与 entryThreshold 单一口径，无死区
    let confidence = 0;
    if (action !== 'HOLD') {
      const t = (Math.abs(score) - entryThreshold) / Math.max(1e-9, 1 - entryThreshold);
      confidence = Number((confidenceFloor + (1 - confidenceFloor) * Math.min(1, Math.max(0, t))).toFixed(2));
    }

    const direction = score > 0 ? '偏多' : score < 0 ? '偏空' : '中性';
    return {
      action,
      confidence,
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
      confidenceFloor: merged.confidenceFloor as number,
    };
  }
}
