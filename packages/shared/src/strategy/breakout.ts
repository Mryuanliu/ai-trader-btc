import type { Strategy, StrategyContext, StrategyOutput } from './types';

/**
 * 通道突破策略：收盘价突破近 N 根已闭合 K 线的高/低点，且放量确认时顺势出手。
 *
 * 与趋势跟踪的区别：不依赖指标合成倾向，只看「价格创出近期极值 + 量能配合」这一事件，
 * 天然适合波动率收缩后的爆发行情。突破幅度决定置信度（触发即通过 minConfidence）。
 *
 * 建议配合出场规则使用（如 ATR 倍数止损）：突破失败的假突破需要果断离场。
 */
export class BreakoutStrategy implements Strategy {
  readonly name = 'breakout';
  readonly label = '通道突破';
  readonly description =
    '收盘价突破近 N 根已闭合 K 线高低点并放量确认时顺势出手；假突破风险建议配合止损出场规则。';

  readonly defaultParams = {
    /** 通道长度：统计最近 N 根已闭合 K 线的高低点 */
    channelBars: 20,
    /** 突破缓冲：收盘价需超过通道极值该比例（0.001 = 0.1%），过滤毛刺 */
    breakBuffer: 0.001,
    /** 量能确认：突破 K 线成交量相对 20 根均量的最低倍数 */
    volConfirm: 1.2,
    /** 触发时的置信度起点（需 >= 引擎 minConfidence） */
    confidenceFloor: 0.6,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      channelBars: { type: 'integer', minimum: 5, maximum: 100, title: '通道长度（根）' },
      breakBuffer: { type: 'number', minimum: 0, maximum: 0.05, title: '突破缓冲比例' },
      volConfirm: { type: 'number', minimum: 0, maximum: 10, title: '量能确认倍数' },
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
      channelBars: Math.round(num(raw?.channelBars, this.defaultParams.channelBars, 5, 100)),
      breakBuffer: num(raw?.breakBuffer, this.defaultParams.breakBuffer, 0, 0.05),
      volConfirm: num(raw?.volConfirm, this.defaultParams.volConfirm, 0, 10),
      confidenceFloor: num(raw?.confidenceFloor, this.defaultParams.confidenceFloor, 0, 1),
    };
  }

  evaluate(ctx: StrategyContext): StrategyOutput {
    const p = this.mergedParams(ctx.params);
    const candles = ctx.candles;

    // 口径与 computeIndicators 一致：只使用已闭合 K 线（末根在实盘是形成中的 K 线）
    const closed = candles.slice(0, -1);
    if (closed.length < p.channelBars + 1) {
      return this.hold(`已闭合 K 线 ${closed.length} 根不足通道长度 ${p.channelBars + 1}，观望`);
    }

    // 突破 K 线 = 最后一根已闭合；通道 = 其之前的 channelBars 根
    const signalBar = closed[closed.length - 1];
    const channel = closed.slice(closed.length - 1 - p.channelBars, closed.length - 1);
    const channelHigh = Math.max(...channel.map((c) => c.high));
    const channelLow = Math.min(...channel.map((c) => c.low));

    // 量能确认（复用指标快照的 volumeRatio：已闭合口径）
    const vr = ctx.indicators.volumeRatio;
    if (Number.isNaN(vr)) return this.hold('量能样本不足，观望');
    if (vr < p.volConfirm) {
      return this.hold(
        `量能比 ${vr.toFixed(2)}x 低于确认阈值 ${p.volConfirm}x，缩量突破不参与`,
      );
    }

    const upTrigger = channelHigh * (1 + p.breakBuffer);
    const downTrigger = channelLow * (1 - p.breakBuffer);
    const close = signalBar.close;

    if (close >= upTrigger) {
      // 突破幅度 → 置信度：以通道宽度的 25% 为满强度基准
      const span = Math.max(1e-9, channelHigh - channelLow);
      const strength = clamp01((close - upTrigger) / (0.25 * span));
      return {
        action: 'BUY',
        confidence: toConfidence(p.confidenceFloor, strength),
        reason:
          `突破买入：收盘 ${close.toFixed(2)} 突破 ${p.channelBars} 根通道高点 ${channelHigh.toFixed(2)}，` +
          `量能比 ${vr.toFixed(2)}x 放量确认。`,
        riskNotes: '突破可能是假突破，建议配合止损出场规则果断离场。',
      };
    }

    if (close <= downTrigger) {
      const span = Math.max(1e-9, channelHigh - channelLow);
      const strength = clamp01((downTrigger - close) / (0.25 * span));
      return {
        action: 'SELL',
        confidence: toConfidence(p.confidenceFloor, strength),
        reason:
          `突破卖出：收盘 ${close.toFixed(2)} 跌破 ${p.channelBars} 根通道低点 ${channelLow.toFixed(2)}，` +
          `量能比 ${vr.toFixed(2)}x 放量确认。`,
        riskNotes: '突破可能是假突破，建议配合止损出场规则果断离场。',
      };
    }

    return this.hold(
      `收盘 ${close.toFixed(2)} 位于通道 ${channelLow.toFixed(2)} ~ ${channelHigh.toFixed(2)} 内，未突破`,
    );
  }

  private hold(note: string): StrategyOutput {
    return {
      action: 'HOLD',
      confidence: 0,
      reason: `按 breakout 指标信号执行：${note}。`,
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
    };
  }

  /** evaluate 内的参数兜底：即使调用方绕过 normalizeParams 传入脏 params 也不崩溃 */
  private mergedParams(params: Record<string, unknown>) {
    const merged = this.normalizeParams({ ...this.defaultParams, ...params });
    return merged as unknown as {
      channelBars: number;
      breakBuffer: number;
      volConfirm: number;
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
