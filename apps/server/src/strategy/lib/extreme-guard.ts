// ---------------------------------------------------------------------------
// M6 三层极端行情熔断（方案 M6 / W5，yuanliu 增强项）——纯函数层
//
// 只拦**新开与加层**，不动出场链（E6 单变量实验语义，默认关）：
// 1. ATR 尖峰：当前 ATR14（简单均值序列现值）/ 近 60 根序列中位数 ≥ 2.0
//    → 全场停开（EA 世界的"新闻室"对 BTC 的对应物：波动结构突变）。
// 2. 量价方向门：近 20 根里顺该方向的成交量占比 < 0.30 → 拦该方向新开。
// 3. 大实体拦截：当根实体 ≥ 2×ATR 且与该方向相反 → 拦该侧。
// ---------------------------------------------------------------------------
import type { Candle } from '@ai-trader/shared';

export interface ExtremeGuardFlags {
  /** ATR 尖峰：拦一切新开 */
  spike: boolean;
  /** 现值/中位数比值（可观测与断言用） */
  atrRatio: number;
  blockLong: boolean;
  blockShort: boolean;
  /** 近端上涨量占比 / 下跌量占比（0–1） */
  upShare: number;
  downShare: number;
}

export interface ExtremeGuardCfg {
  atrSpikeMult: number;
  volDirGate: number;
  bodyAtrMult: number;
}

const ATR_PERIOD = 14;

/** true range 序列（candles[1..]，与 atrSimple 同口径的简单均值基础） */
function trueRanges(candles: Candle[]): number[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return tr;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 三层熔断评估。数据不足（< 15+2 根）返回全 false（宁放行不误拦——
 * 与 EA 冷启动行为一致：指标没就绪就不构成拦截证据）。
 */
export function extremeGuardFlags(
  candles: Candle[],
  cfg: ExtremeGuardCfg,
  spikeLookback = 60,
  volLookback = 20,
): ExtremeGuardFlags {
  const none: ExtremeGuardFlags = { spike: false, atrRatio: 1, blockLong: false, blockShort: false, upShare: 1, downShare: 1 };
  const tr = trueRanges(candles);
  if (tr.length < ATR_PERIOD + 2) return none;

  // ATR14 简单均值滑动序列
  const atrSeries: number[] = [];
  for (let i = ATR_PERIOD - 1; i < tr.length; i++) {
    let sum = 0;
    for (let k = 0; k < ATR_PERIOD; k++) sum += tr[i - k];
    atrSeries.push(sum / ATR_PERIOD);
  }
  const cur = atrSeries[atrSeries.length - 1];
  const window = atrSeries.slice(-spikeLookback);
  const med = median(window.slice(0, Math.max(0, window.length - 1))); // 中位数不含当值
  const atrRatio = med > 0 ? cur / med : 1;
  const spike = atrRatio >= cfg.atrSpikeMult;

  // 量价方向门：近 volLookback 根，按收盘涨跌分方向计量
  const from = Math.max(1, candles.length - volLookback);
  let upVol = 0;
  let dnVol = 0;
  for (let i = from; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) upVol += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) dnVol += candles[i].volume;
  }
  const tot = upVol + dnVol;
  const upShare = tot > 0 ? upVol / tot : 1;
  const downShare = tot > 0 ? dnVol / tot : 1;

  // 大实体拦截（当根）：阴线拦 LONG、阳线拦 SHORT
  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  const bigBear = last.close < last.open && body >= cfg.bodyAtrMult * cur;
  const bigBull = last.close > last.open && body >= cfg.bodyAtrMult * cur;

  return {
    spike,
    atrRatio,
    blockLong: spike || bigBear || upShare < cfg.volDirGate,
    blockShort: spike || bigBull || downShare < cfg.volDirGate,
    upShare,
    downShare,
  };
}
