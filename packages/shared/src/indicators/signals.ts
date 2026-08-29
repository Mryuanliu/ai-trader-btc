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

/** 由指标快照合成结构化信号 */
export function buildSignals(snapshot: IndicatorSnapshot, candles: Candle[]): Signal[] {
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

  // RSI 超买超卖
  const rsiValue = snapshot.rsi14;
  let rsiBias: SignalBias = 'neutral';
  let rsiNote = 'RSI 处于中性区间';
  if (!Number.isNaN(rsiValue)) {
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

function fmt(v: number): string {
  return Number.isNaN(v) ? 'N/A' : v.toFixed(2);
}
