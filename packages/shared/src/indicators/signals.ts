import type { Candle } from '../types/market';
import type { IndicatorSnapshot, Signal, SignalBias } from '../types/agent';
import { atr, bollinger, ema, macd, rsi, sma } from './core';

/** 计算指标快照（不足周期返回 NaN，由调用方决定如何处理） */
export function computeIndicators(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);
  // 量能统计只使用已闭合 K 线：最后一根在实盘是形成中的 K 线，成交量未累积完，
  // 混入统计会让 volumeRatio 恒偏小（缺陷③）。回测引擎为保持同一口径，同样排除末根。
  const closedVolumes = volumes.slice(0, -1);
  const avgVolume20 = sma(closedVolumes, 20);
  const lastClosedVolume = closedVolumes[closedVolumes.length - 1] ?? 0;

  return {
    sma5: sma(closes, 5),
    sma10: sma(closes, 10),
    sma20: sma(closes, 20),
    sma60: sma(closes, 60),
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    rsi14: rsi(closes, 14),
    macd: macdRes.macd,
    macdSignal: macdRes.signal,
    macdHist: macdRes.histogram,
    bollUpper: boll.upper,
    bollMid: boll.mid,
    bollLower: boll.lower,
    atr14: atr(highs, lows, closes, 14),
    volumeRatio: avgVolume20 > 0 ? lastClosedVolume / avgVolume20 : NaN,
    lastClose: closes[closes.length - 1] ?? NaN,
  };
}

function bias(condition: boolean | null, bull: SignalBias = 'bullish'): SignalBias {
  if (condition === null) return 'neutral';
  return condition ? bull : bull === 'bullish' ? 'bearish' : 'bullish';
}

/**
 * RSI 语义模式（B3）。
 *
 * RSI 有两种**方向完全相反**的解读，混用会造成语义反转：
 *
 * - `reversion`（均值回归语义，默认）：RSI 越高越接近顶部 → 超买看跌、超卖看涨。
 *   适用于 mean_reversion 这类"高抛低吸"策略。
 * - `trend`（动量/趋势语义）：RSI 越高说明上涨动能越强 → 高 RSI 看涨、低 RSI 看跌。
 *   适用于 trend_following 这类"追涨杀跌"策略。
 *
 * 修复前后的行为对比（reversion 模式下 RSI=75）：
 *   旧实现：RSI>=70 → bearish（超买看跌）
 *   新实现：reversion 保持 bearish；trend 模式改为 bullish（动能强）
 *
 * 为什么要参数化：`buildSignals` 原先硬编码 reversion，而 trend_following 用的
 * 也是这套信号——导致趋势策略在**最该跟涨的超买区反而收到看跌票**（实测 RSI>=70 时
 * 794 次全判 bearish，与 RSI 55~70 的 5282 次 bullish 方向相反，构成语义反转）。
 */
export type RsiMode = 'reversion' | 'trend';

/** buildSignals 的可选参数 */
export interface BuildSignalsOptions {
  /**
   * RSI 语义模式。默认 `reversion`（与历史行为一致，零回归）。
   * 趋势类策略应显式传 `trend`。
   */
  rsiMode?: RsiMode;
}

/** 由指标快照合成结构化信号 */
export function buildSignals(
  snapshot: IndicatorSnapshot,
  candles: Candle[],
  options: BuildSignalsOptions = {},
): Signal[] {
  const rsiMode: RsiMode = options.rsiMode === 'trend' ? 'trend' : 'reversion';
  const signals: Signal[] = [];
  const close = snapshot.lastClose;
  const closes = candles.map((c) => c.close);

  // 趋势：均线多空排列
  const trendBull = close > snapshot.sma20 && snapshot.sma5 > snapshot.sma20;
  signals.push({
    name: 'ma_trend',
    label: '均线趋势 (SMA5/20)',
    value: `SMA5 ${fmt(snapshot.sma5)} / SMA20 ${fmt(snapshot.sma20)}`,
    bias: trendBull ? 'bullish' : 'bearish',
    weight: 0.25,
    note: trendBull ? '价格站上中期均线，短中期多头排列' : '价格位于中期均线下方，短中期空头排列',
  });

  // RSI 超买超卖（语义由 rsiMode 决定，避免两种相反解读混用）
  const rsiValue = snapshot.rsi14;
  let rsiBias: SignalBias = 'neutral';
  let rsiNote = 'RSI 处于中性区间';
  if (!Number.isNaN(rsiValue)) {
    if (rsiMode === 'trend') {
      // 动量语义：RSI 高低代表动能强弱，越高越看涨
      if (rsiValue >= 70) {
        rsiBias = 'bullish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 动能强劲，趋势延续概率高`;
      } else if (rsiValue <= 30) {
        rsiBias = 'bearish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 动能疲弱，下行趋势延续`;
      } else if (rsiValue > 55) {
        rsiBias = 'bullish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 偏强`;
      } else if (rsiValue < 45) {
        rsiBias = 'bearish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 偏弱`;
      }
    } else {
      // 均值回归语义：RSI 越高越接近顶部，超买看跌、超卖看涨
      if (rsiValue >= 70) {
        rsiBias = 'bearish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 进入超买区，警惕回落`;
      } else if (rsiValue <= 30) {
        rsiBias = 'bullish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 进入超卖区，存在反弹空间`;
      } else if (rsiValue > 55) {
        rsiBias = 'bullish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 偏强`;
      } else if (rsiValue < 45) {
        rsiBias = 'bearish';
        rsiNote = `RSI ${rsiValue.toFixed(1)} 偏弱`;
      }
    }
  }
  signals.push({
    name: 'rsi',
    label: 'RSI(14)',
    value: Number.isNaN(rsiValue) ? 'N/A' : rsiValue.toFixed(2),
    bias: rsiBias,
    weight: 0.2,
    note: rsiNote,
  });

  // MACD 柱状动能
  const hist = snapshot.macdHist;
  const macdBias: SignalBias = Number.isNaN(hist)
    ? 'neutral'
    : hist > 0
      ? 'bullish'
      : hist < 0
        ? 'bearish'
        : 'neutral';
  signals.push({
    name: 'macd',
    label: 'MACD(12,26,9)',
    value: Number.isNaN(hist) ? 'N/A' : hist.toFixed(2),
    bias: macdBias,
    weight: 0.2,
    note: macdBias === 'bullish' ? '柱状线为正，上涨动能占优' : '柱状线为负，下跌动能占优',
  });

  // 布林带位置
  let bollBias: SignalBias = 'neutral';
  let bollNote = '价格位于布林带中轨附近';
  if (!Number.isNaN(snapshot.bollUpper) && snapshot.bollUpper > snapshot.bollLower) {
    const pos = (close - snapshot.bollLower) / (snapshot.bollUpper - snapshot.bollLower);
    if (pos >= 0.9) {
      bollBias = 'bearish';
      bollNote = '价格触及布林上轨，短期过热';
    } else if (pos <= 0.1) {
      bollBias = 'bullish';
      bollNote = '价格触及布林下轨，短期超跌';
    }
  }
  signals.push({
    name: 'bollinger',
    label: '布林带(20,2)',
    value: `${fmt(snapshot.bollLower)} ~ ${fmt(snapshot.bollUpper)}`,
    bias: bollBias,
    weight: 0.15,
    note: bollNote,
  });

  // 量能：基于最后一根已闭合 K 线（与 volumeRatio 同口径）
  const vr = snapshot.volumeRatio;
  const lastClosedClose = closes[closes.length - 2] ?? close;
  const priorClosedClose = closes[closes.length - 3] ?? lastClosedClose;
  const closedCandleUp = lastClosedClose >= priorClosedClose;
  const volumeBias: SignalBias = Number.isNaN(vr)
    ? 'neutral'
    : closedCandleUp
      ? vr > 1.2
        ? 'bullish'
        : 'neutral'
      : vr > 1.2
        ? 'bearish'
        : 'neutral';
  signals.push({
    name: 'volume',
    label: '量能比 (前收/20均)',
    value: Number.isNaN(vr) ? 'N/A' : `${vr.toFixed(2)}x`,
    bias: volumeBias,
    weight: 0.1,
    note: Number.isNaN(vr)
      ? '样本不足'
      : vr > 1.2
        ? '上一根已闭合 K 线放量，方向确认度提升'
        : '缩量，信号强度有限',
  });

  // 中期位置（相对 SMA60）
  let midBias: SignalBias = 'neutral';
  if (!Number.isNaN(snapshot.sma60)) {
    midBias = close > snapshot.sma60 ? 'bullish' : 'bearish';
  }
  signals.push({
    name: 'mid_term',
    label: '中期位置 (SMA60)',
    value: fmt(snapshot.sma60),
    bias: midBias,
    weight: 0.1,
    note: midBias === 'bullish' ? '价格高于 60 周期均线' : '价格低于 60 周期均线',
  });

  return signals;
}

/** 将信号加权合成为 -1 ~ 1 的倾向分值。
 * 缺陷②修复：分母使用全部信号权重（而非仅非中性部分），
 * 「六个信号全部看多」才是 1.0，单信号看多只能拿到其权重占比——信号越多越可信，方向一致才高 */
export function scoreSignals(signals: Signal[]): number {
  let total = 0;
  let totalWeight = 0;
  for (const s of signals) {
    if (s.bias === 'neutral') continue;
    total += (s.bias === 'bullish' ? 1 : -1) * s.weight;
  }
  totalWeight = signals.reduce((acc, s) => acc + s.weight, 0);
  return totalWeight === 0 ? 0 : Number((total / totalWeight).toFixed(4));
}

/** 单个信号对综合倾向的有符号贡献 */
export interface SignalContribution {
  name: string;
  label: string;
  bias: SignalBias;
  weight: number;
  /** 有符号贡献：bullish=+weight，bearish=-weight，neutral=0 */
  signed: number;
  note?: string;
}

/** scoreSignalsDetailed 的输出：总分 + 逐信号归因 + 达标差距 */
export interface SignalScoreDetail {
  /**
   * 【旧口径】综合倾向 -1~1 = 表态净值 / 全部权重（与 scoreSignals 完全同值）。
   * 保留用于向后兼容与口径对比；新代码请使用 consensus + agreement。
   */
  score: number;
  /**
   * 【新口径 B2】一致度 -1~1 = 表态净值 / 表态权重。
   * 表达"已表态信号之间有多一致"，不受弃权信号稀释。
   * 需配合 agreement 使用，否则单个信号表态就能达到 ±1。
   */
  consensus: number;
  /** 全部信号权重之和 */
  totalWeight: number;
  /** 参与表态（非 neutral）的权重之和 */
  activeWeight: number;
  /** 参与表态的权重占比 0~1，即「多少比例的信号投了票」 */
  agreement: number;
  /** 逐信号有符号贡献，按 |signed| 降序（谁的影响最大一目了然） */
  contributions: SignalContribution[];
  /** 若要达到指定阈值，还需要的同向权重（已达标则为 0） */
  gapToThreshold: number;
}

/**
 * 信号打分的详细版本：除总分外，返回逐信号贡献与达标差距。
 *
 * 与 scoreSignals 同源同口径（分子不计 neutral、分母含全部权重），
 * 因此 score 字段与 scoreSignals(signals) 严格相等，可安全并行运行对比。
 *
 * 用途：回答「为什么没开仓」——是哪个信号弃权、哪个信号投了反对票、还差多少。
 *
 * @param signals 信号数组
 * @param threshold 触发阈值（正数，如 0.85）；用于计算 gapToThreshold
 */
export function scoreSignalsDetailed(signals: Signal[], threshold = 0): SignalScoreDetail {
  const list = signals ?? [];
  let total = 0;
  let totalWeight = 0;
  let activeWeight = 0;
  const contributions: SignalContribution[] = [];

  for (const s of list) {
    totalWeight += s.weight;
    if (s.bias === 'neutral') {
      contributions.push({ name: s.name, label: s.label, bias: s.bias, weight: s.weight, signed: 0, note: s.note });
      continue;
    }
    activeWeight += s.weight;
    const signed = s.bias === 'bullish' ? s.weight : -s.weight;
    total += signed;
    contributions.push({ name: s.name, label: s.label, bias: s.bias, weight: s.weight, signed, note: s.note });
  }

  // 【旧口径】score = 表态净值 / 全部权重。
  // 缺陷：弃权信号占分母却不进分子，会被系统性稀释——
  // 六个信号全看多但只要 bollinger(0.15) 弃权，score 就只有 0.85；
  // 若 rsi+boll 双双弃权则只有 0.75，永远够不到 0.85 的阈值（实测线上最高仅 0.65）。
  const score = totalWeight === 0 ? 0 : Number((total / totalWeight).toFixed(4));

  // 【新口径 B2】consensus = 表态净值 / 表态权重，表达「已表态信号之间的一致程度」。
  // 全看多且无弃权时为 1.0；有弃权也不再被稀释（弃权不计入分母）。
  // 与 agreement 配套使用：consensus 防"方向不一致"，agreement 防"表态者太少时以偏概全"。
  const consensus = activeWeight === 0 ? 0 : Number((total / activeWeight).toFixed(4));

  // 参与表态的权重占比 0~1（"多少比例的信号投了票"）
  const agreement = totalWeight === 0 ? 0 : Number((activeWeight / totalWeight).toFixed(4));

  // 达标差距（按新口径 consensus 计算）：还需多少比例的同向表态才能触及阈值
  const gapToThreshold =
    activeWeight === 0
      ? Number(Math.abs(threshold).toFixed(4))
      : Number(Math.max(0, Math.abs(threshold) - Math.abs(consensus)).toFixed(4));

  // 按影响力降序（绝对值大的在前），便于一眼定位主导信号
  contributions.sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed) || b.weight - a.weight);

  return {
    score,
    consensus,
    totalWeight,
    activeWeight,
    agreement,
    contributions,
    gapToThreshold,
  };
}

function fmt(v: number): string {
  return Number.isNaN(v) ? 'N/A' : v.toFixed(2);
}
