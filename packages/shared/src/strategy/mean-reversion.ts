import type { Strategy, StrategyContext, StrategyOutput } from './types';
import { scoreSignalsDetailed } from '../indicators/signals';
import type { BlockingReasonCode, SignalContribution } from '../decision-diagnostics';

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
  /** 均值回归 = 高抛低吸，RSI 读作超买超卖（默认语义），显式声明避免歧义 */
  readonly rsiMode = 'reversion' as const;
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
    /**
     * 回归出场带下界（持仓感知出场，B4）。
     * 持有多单时 %b 回到 [exitBandPosLow, exitBandPosHigh] 即视为「回归均值」→ 卖出平仓。
     *
     * 为什么必须有：卖出若只依赖「反向超买」（rsiOverbought/bandPosHigh），
     * 等于要求价格从超卖一路涨到超买——均值回归行情里价格往往回到中轨就掉头，
     * 永远等不到反向极端，造成「只买不卖」。回归中轨才是本策略的核心盈利兑现点。
     */
    exitBandPosLow: 0.4,
    /** 回归出场带上界 */
    exitBandPosHigh: 0.6,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      rsiOversold: { type: 'number', minimum: 0, maximum: 100, title: 'RSI 超卖阈值' },
      rsiOverbought: { type: 'number', minimum: 0, maximum: 100, title: 'RSI 超买阈值' },
      bandPosLow: { type: 'number', minimum: 0, maximum: 1, title: '布林下轨区 %b' },
      bandPosHigh: { type: 'number', minimum: 0, maximum: 1, title: '布林上轨区 %b' },
      confidenceFloor: { type: 'number', minimum: 0, maximum: 1, title: '触发时置信度起点' },
      exitBandPosLow: { type: 'number', minimum: 0, maximum: 1, title: '回归出场带下界 %b' },
      exitBandPosHigh: { type: 'number', minimum: 0, maximum: 1, title: '回归出场带上界 %b' },
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
      exitBandPosLow: num(raw?.exitBandPosLow, this.defaultParams.exitBandPosLow, 0, 1),
      exitBandPosHigh: num(raw?.exitBandPosHigh, this.defaultParams.exitBandPosHigh, 0, 1),
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
      // 数据层阻塞：关键指标缺失，与「信号未触发」是截然不同的排查路径
      return this.hold('指标样本不足或带宽为 0，观望', 0, 'INDICATOR_NAN');
    }

    const bandPos = (lastClose - bollLower) / (bollUpper - bollLower);

    // ---- 持仓感知出场（B4 修复「只买不卖」）----
    // 均值回归的盈利兑现点是「价格回归均值（中轨）」，而非等到反向超买。
    // 持有多单时：%b 回到出场带 [exitBandPosLow, exitBandPosHigh] → SELL 平仓。
    // 该分支必须放在开仓判定之前——出场优先于加仓。
    const posQty = Number(ctx.position?.quantity ?? 0);
    if (posQty > 0) {
      if (bandPos >= p.exitBandPosLow && bandPos <= p.exitBandPosHigh) {
        // 回归深度：越接近中轨（0.5）置信越高
        const depth = 1 - Math.abs(bandPos - 0.5) / Math.max(1e-9, (p.exitBandPosHigh - p.exitBandPosLow) / 2);
        const confidence = toConfidence(p.confidenceFloor, clamp01(depth));
        return {
          action: 'SELL',
          confidence,
          proximity: 1,
          reason:
            `均值回归出场：持仓回归均值达成——%b ${bandPos.toFixed(3)} 已回到出场带 ` +
            `[${p.exitBandPosLow}, ${p.exitBandPosHigh}]（布林中轨附近），低估修复，兑现盈利。`,
          riskNotes: '回归出场为本策略的主要止盈路径；反向极端出场（rsiOverbought）作为次级兜底。',
          diagnostics: {
            gapToTrigger: 0,
            score: bandPos,
            requiredScore: p.exitBandPosLow,
            contributions: scoreSignalsDetailed(ctx.signals).contributions,
            detail: `出场模式：持仓 ${posQty}，%b ${bandPos.toFixed(4)} 在出场带内`,
          },
        };
      }
      // 持仓期间不出 BUY（避免无限加仓）；反向极端出场与 HOLD 走下方原逻辑
    }

    // 超卖 → BUY：价格触及下轨区 且 RSI 超卖，双条件同时满足。
    // 已持有多单时不再重复买入（避免无限加仓）——出场由上方回归出场带负责。
    if (posQty <= 0 && bandPos <= p.bandPosLow && rsi14 <= p.rsiOversold) {
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
      this.proximityOf(bandPos, rsi14, p),
      'SIGNAL_NONE',
      scoreSignalsDetailed(ctx.signals).contributions,
    );
  }

  /**
   * 观望输出。
   *
   * 修复：原实现 confidence 恒为 0、reason 仅自由文本，导致每
   * 一条 HOLD 都丢失信息量（无法区分「差一点」还是「差得远」）。
   * 现补充 proximity（接近度）与 diagnostics（结构化归因）。
   */
  private hold(
    note: string,
    proximity = 0,
    code: BlockingReasonCode = 'SIGNAL_NONE',
    contributions?: SignalContribution[],
  ): StrategyOutput {
    return {
      action: 'HOLD',
      confidence: 0,
      proximity: Number(Math.max(0, Math.min(1, proximity)).toFixed(3)),
      reason: `按 mean_reversion 指标信号执行：${note}。`,
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
      diagnostics: {
        code,
        // 本策略不走 indicatorScore，而是布林位置 + RSI 双条件；
        // 用接近度反推差距，保持与 trend_following 面板列的语义一致（"还差多少比例"）
        gapToTrigger: Number(Math.max(0, 1 - Math.max(0, Math.min(1, proximity))).toFixed(4)),
        contributions,
        detail: note,
      },
    };
  }

  /**
   * 计算距触发的接近度（0~1）。
   *
   * 本策略是**双条件 AND**（布林位置 + RSI 同时达标才出手），
   * 故每个方向内取两个条件的**较小值**（木桶效应——最弱的条件决定能否触发），
   * 两个方向（做多/做空）之间取**较大值**（表达「哪个方向更有希望」）。
   */
  private proximityOf(
    bandPos: number,
    rsi14: number,
    p: { bandPosLow: number; bandPosHigh: number; rsiOversold: number; rsiOverbought: number },
  ): number {
    // 向下触发（BUY）：bandPos 需降到 bandPosLow 以下、rsi 需降到 rsiOversold 以下
    const bandToBuy = bandPos <= p.bandPosLow ? 1 : clamp01(p.bandPosLow / Math.max(1e-9, bandPos));
    const rsiToBuy = rsi14 <= p.rsiOversold ? 1 : clamp01(p.rsiOversold / Math.max(1e-9, rsi14));
    const toBuy = Math.min(bandToBuy, rsiToBuy);

    // 向上触发（SELL）：bandPos 需升到 bandPosHigh 以上、rsi 需升到 rsiOverbought 以上
    const bandToSell = bandPos >= p.bandPosHigh ? 1 : clamp01(bandPos / Math.max(1e-9, p.bandPosHigh));
    const rsiToSell = rsi14 >= p.rsiOverbought ? 1 : clamp01(rsi14 / Math.max(1e-9, p.rsiOverbought));
    const toSell = Math.min(bandToSell, rsiToSell);

    return Number(Math.max(toBuy, toSell).toFixed(3));
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
      exitBandPosLow: number;
      exitBandPosHigh: number;
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
