import type { Strategy, StrategyContext, StrategyOutput } from './types';
import { scoreSignalsDetailed } from '../indicators/signals';
import { proximityToTrigger } from '../decision-diagnostics';

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
  /**
   * 趋势跟随 = 追涨杀跌，RSI 应读作**动能**而非超买超卖。
   * 用 reversion 语义会让最强的上涨动能（RSI>=70）被判为看跌，与策略逻辑相反。
   */
  readonly rsiMode = 'trend' as const;
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
    /**
     * 打分口径（B2）。
     * - 'legacy'（默认）：沿用 scoreSignals 口径，分子只算表态信号、分母含全部权重。
     *   缺陷：弃权信号占分母却不进分子，会被系统性稀释——六信号全看多但 bollinger 弃权
     *   时 score 只有 0.85，rsi+boll 双双弃权仅 0.75，线上实测绝对值最高只有 0.65。
     * - 'consensus'：新口径，分子分母都只算表态信号，表达"已表态信号的一致度"，
     *   不受弃权稀释。需同时满足 agreement >= minAgreement，避免单信号独断。
     *
     * 默认保持 'legacy'：**entryThreshold=0.85 是在 legacy 口径下经双窗口回测校准的**，
     * 切到 consensus 会改变 score 分布、使已校准阈值失效，必须重新扫描校准后再切。
     */
    scoreMode: 'legacy' as 'legacy' | 'consensus',
    /**
     * 最小表态率（仅 consensus 口径生效）：参与表态的信号权重占比下限。
     * 防止"只有一两个信号投票"时以偏概全——consensus 只看表态者之间是否一致，
     * 不看有多少人表态，故需此参数兜底。
     * 默认 0.6：考虑到 bollinger 常年约 80% 时间 neutral（单它弃权时 agreement=0.85），
     * 设过高会导致同样不触发。
     */
    minAgreement: 0.6,
  };

  readonly paramSchema = {
    type: 'object',
    properties: {
      entryThreshold: { type: 'number', minimum: 0, maximum: 1, title: '开仓阈值' },
      confidenceFloor: { type: 'number', minimum: 0, maximum: 1, title: '触发时置信度起点' },
      scoreMode: {
        type: 'string',
        enum: ['legacy', 'consensus'],
        title: '打分口径',
        description: 'legacy=沿用旧口径；consensus=改用一致度口径（需重新校准阈值）',
      },
      minAgreement: { type: 'number', minimum: 0, maximum: 1, title: '最小表态率（consensus 口径）' },
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
      scoreMode: raw?.scoreMode === 'consensus' ? 'consensus' : 'legacy',
      minAgreement: num(raw?.minAgreement, this.defaultParams.minAgreement, 0, 1),
    };
  }

  evaluate(ctx: StrategyContext): StrategyOutput {
    const { entryThreshold, confidenceFloor, scoreMode, minAgreement } = this.mergedParams(ctx.params);

    // 逐信号归因：定位「哪个信号拖后腿 / 弃权 / 投反对票」
    const detail = scoreSignalsDetailed(ctx.signals, entryThreshold);
    const useConsensus = scoreMode === 'consensus';

    // legacy 口径沿用 ctx.indicatorScore（引擎用 scoreSignals 算的，保证与历史行为逐字节一致）；
    // consensus 口径改用「表态信号之间的一致度」，不再被弃权信号稀释
    const score = useConsensus ? detail.consensus : ctx.indicatorScore;

    let action: StrategyOutput['action'] = 'HOLD';
    if (Math.abs(score) >= entryThreshold) {
      // consensus 口径额外要求表态率，避免"只有少数信号投票"时以偏概全
      if (!useConsensus || detail.agreement >= minAgreement) {
        action = score > 0 ? 'BUY' : 'SELL';
      }
    }

    // 缺陷①修复：置信度只由「越过阈值的幅度」映射，触发即 >= confidenceFloor，
    // 与 entryThreshold 单一口径，无死区
    let confidence = 0;
    if (action !== 'HOLD') {
      const t = (Math.abs(score) - entryThreshold) / Math.max(1e-9, 1 - entryThreshold);
      confidence = Number((confidenceFloor + (1 - confidenceFloor) * Math.min(1, Math.max(0, t))).toFixed(2));
    }

    // 接近度：观望时仍携带信息量。0.76 = 已达触发所需的 76%，还差 24%
    // 新增字段而非改 confidence，避免影响 minConfidence 拦截与回测仓位口径（零风险增量）
    //
    // consensus 模式是双条件 AND（一致度 + 表态率都要达标），
    // 按木桶效应取两者的较小值——最弱的条件决定能否触发
    let proximity = proximityToTrigger(score, entryThreshold);
    if (useConsensus) {
      const agreementProx = minAgreement <= 0 ? 1 : Math.min(1, detail.agreement / minAgreement);
      proximity = Number(Math.min(proximity, agreementProx).toFixed(3));
    }

    const direction = score > 0 ? '偏多' : score < 0 ? '偏空' : '中性';
    return {
      action,
      confidence,
      proximity,
      reason:
        `按 trend_following 指标信号执行：综合倾向 ${score.toFixed(2)}（${direction}），` +
        `采用 MA/RSI/MACD/布林带加权结果。` +
        (action === 'HOLD'
          ? `未达开仓阈值 ${entryThreshold}（已达 ${(proximity * 100).toFixed(0)}%，` +
            `参与表态信号权重占比 ${(detail.agreement * 100).toFixed(0)}%` +
            (useConsensus
              ? `，表态率下限 ${(minAgreement * 100).toFixed(0)}%`
              : '') +
            `）。`
          : ''),
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
      // 已触发时不带 code（没有阻塞），但仍保留贡献度供下钻；观望时标 SIGNAL_NONE
      diagnostics: {
        code: action === 'HOLD' ? 'SIGNAL_NONE' : undefined,
        // 按**当前生效的口径**计算差距，而非 scoreSignalsDetailed 里固定按 consensus 算的值；
        // 否则 legacy 模式下显示的差距会与新口径混淆（两者数值不同）
        gapToTrigger: Number(Math.max(0, entryThreshold - Math.abs(score)).toFixed(4)),
        score,
        requiredScore: entryThreshold,
        contributions: detail.contributions,
        // 两个口径都输出，便于并行对比与后续重新校准阈值
        // （B2 切到 consensus 后，legacy 口径下校准的 0.85 将失效，需重新扫描）
        detail:
          `口径=${scoreMode} ` +
          `score(legacy)=${detail.score.toFixed(4)} ` +
          `consensus=${detail.consensus.toFixed(4)} ` +
          `agreement=${detail.agreement.toFixed(4)}` +
          (useConsensus ? ` minAgreement=${minAgreement.toFixed(2)}` : '') +
          ` | 阈值 ${entryThreshold}，差距 ${detail.gapToThreshold.toFixed(4)}` +
          (action !== 'HOLD' ? ` | 已触发 ${action}` : ''),
      },
    };
  }

  /** evaluate 内的参数兜底：即使调用方绕过 normalizeParams 传入脏 params 也不崩溃 */
  private mergedParams(params: Record<string, unknown>) {
    const merged = this.normalizeParams({ ...this.defaultParams, ...params });
    return {
      entryThreshold: merged.entryThreshold as number,
      confidenceFloor: merged.confidenceFloor as number,
      scoreMode: (merged.scoreMode === 'consensus' ? 'consensus' : 'legacy') as
        | 'legacy'
        | 'consensus',
      minAgreement: merged.minAgreement as number,
    };
  }
}
