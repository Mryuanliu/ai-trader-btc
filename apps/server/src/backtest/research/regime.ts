import {
  TIMEFRAME_MS,
  type Candle,
  type RegimeBucket,
  type RegimeLabel,
  type RegimeSummary,
} from '@ai-trader/shared';
import { annualizeSharpe, sharpePerBar } from './stats';

const DAY_MS = 86_400_000;

/**
 * Regime 分层（闸门 A6 判据之一：任一市况下 OOS Sharpe 崩塌即拒绝）。
 *
 * 分类口径（主流且可辩护，避免用策略自身参数自证）：
 * - **趋势方向**：日线 close vs SMA(`trendWindow`=200) —— 上方 bull、下方 bear；
 *   |close/SMA − 1| < `trendBandPct` 视为无方向 → neutral。
 * - **波动状态**：30d 已实现波动在**滚动窗口内的分位** > 0.6 → highvol、< 0.4 → lowvol，
 *   居中并入 neutral（保持 5 类标签的可解释性）。
 *
 * 全部只用 i 时刻**之前**的日线，杜绝前视。
 */
const REGIME_ORDER: RegimeLabel[] = [
  'bull_lowvol',
  'bull_highvol',
  'bear_lowvol',
  'bear_highvol',
  'neutral',
];

export interface RegimeClassifyOptions {
  /** 趋势均线窗口（日线根数），默认 200 */
  trendWindow?: number;
  /** 已实现波动滚动窗口（日线根数），默认 30 */
  volWindow?: number;
  /** 分位回看窗口（日线根数），默认 252 */
  volLookback?: number;
  /** 中性带：|close/SMA − 1| 小于此比例判 neutral，默认 0.02 */
  trendBandPct?: number;
  /** 波动分位高/低阈值 */
  volHighQ?: number;
  volLowQ?: number;
}

/** 日分位（升序线性插值） */
function quantileOf(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1] ?? sortedAsc[base];
  return sortedAsc[base] + rest * (next - sortedAsc[base]);
}

/** 把回测周期的 K 线聚合为日线收盘（按 UTC 日历日取最后一根收盘） */
export function aggregateDailyCloses(candles: Candle[]): { time: number; close: number }[] {
  const out: { time: number; close: number }[] = [];
  let curDay = Number.NaN;
  for (const c of candles) {
    const day = Math.floor(c.time / DAY_MS) * DAY_MS;
    if (day !== curDay) {
      out.push({ time: day, close: c.close });
      curDay = day;
    } else {
      out[out.length - 1].close = c.close;
    }
  }
  return out;
}

/**
 * 标注日线 regime：返回 dayTs → label。
 * 历史不足（trendWindow + volLookback）的早期日线不标注。
 */
export function classifyDailyRegimes(
  dailyCloses: { time: number; close: number }[],
  opts: RegimeClassifyOptions = {},
): Map<number, RegimeLabel> {
  const trendWindow = Math.max(2, opts.trendWindow ?? 200);
  const volWindow = Math.max(2, opts.volWindow ?? 30);
  const volLookback = Math.max(volWindow + 1, opts.volLookback ?? 252);
  const bandPct = opts.trendBandPct ?? 0.02;
  const volHighQ = opts.volHighQ ?? 0.6;
  const volLowQ = opts.volLowQ ?? 0.4;

  const n = dailyCloses.length;
  const closes = dailyCloses.map((d) => d.close);
  /** 日对数收益（i 表示 close[i]→close[i+1] 那天的收益，这里按「进入 i 日」对齐） */
  const logRet: number[] = [];
  for (let i = 1; i < n; i += 1) {
    logRet.push(Math.log(closes[i] / Math.max(1e-9, closes[i - 1])));
  }

  const out = new Map<number, RegimeLabel>();
  for (let i = 0; i < n; i += 1) {
    if (i < trendWindow - 1 || i < volLookback) continue;

    // 趋势：截至 i 日（含）的 SMA
    let sum = 0;
    for (let k = i - trendWindow + 1; k <= i; k += 1) sum += closes[k];
    const sma = sum / trendWindow;
    const rel = closes[i] / sma - 1;

    // 波动：以 i 日为终点的 volWindow 日已实现波动；与回看窗口内的分布比分位
    let vsum = 0;
    let vcnt = 0;
    for (let k = i - volWindow; k < i; k += 1) {
      const r = logRet[k];
      if (Number.isFinite(r)) {
        vsum += r * r;
        vcnt += 1;
      }
    }
    if (vcnt < 2) continue;
    const volNow = Math.sqrt(vsum / vcnt);

    const hist: number[] = [];
    for (let e = i - volLookback; e < i; e += 1) {
      let hs = 0;
      let hc = 0;
      for (let k = e - volWindow; k < e; k += 1) {
        const r = logRet[k];
        if (Number.isFinite(r)) {
          hs += r * r;
          hc += 1;
        }
      }
      if (hc >= 2) hist.push(Math.sqrt(hs / hc));
    }
    if (hist.length < volWindow) continue;
    hist.sort((a, b) => a - b);
    const rank = hist.filter((v) => v <= volNow).length / hist.length;

    let label: RegimeLabel;
    if (Math.abs(rel) < bandPct) label = 'neutral';
    else {
      const dir = rel > 0 ? 'bull' : 'bear';
      if (rank > volHighQ) label = `${dir}_highvol` as RegimeLabel;
      else if (rank < volLowQ) label = `${dir}_lowvol` as RegimeLabel;
      else label = 'neutral';
    }
    out.set(dailyCloses[i].time, label);
  }
  return out;
}

/**
 * regime 分层汇总：把**带时间戳的逐根 OOS 收益**按当期 regime 分桶，各桶算年化 Sharpe。
 *
 * 时间对不齐（如 walk-forward 拼接曲线的近似时间轴）时该根记为 unclassified 并跳过。
 */
export function regimeSummary(
  retsWithTime: { time: number; ret: number }[],
  regimeByDay: Map<number, RegimeLabel>,
  interval: keyof typeof TIMEFRAME_MS,
): RegimeSummary {
  const buckets = new Map<RegimeLabel, number[]>();
  let classified = 0;
  for (const { time, ret } of retsWithTime) {
    const label = regimeByDay.get(Math.floor(time / DAY_MS) * DAY_MS);
    if (!label) continue;
    classified += 1;
    const arr = buckets.get(label) ?? [];
    arr.push(ret);
    buckets.set(label, arr);
  }

  const barsPerYear = (365 * DAY_MS) / TIMEFRAME_MS[interval];
  const details: RegimeBucket[] = [];
  for (const label of REGIME_ORDER) {
    const rets = buckets.get(label);
    if (!rets || rets.length === 0) continue;
    details.push({
      regime: label,
      bars: rets.length,
      oosSharpe: Number(annualizeSharpe(sharpePerBar(rets), barsPerYear).toFixed(4)),
      weightPct: Number(((rets.length / classified) * 100).toFixed(2)),
    });
  }

  return {
    buckets: details,
    regimesCovered: details.length,
    minRegimeSharpe: details.length
      ? Number(Math.min(...details.map((d) => d.oosSharpe)).toFixed(4))
      : Number.NaN,
    classifiedBars: classified,
  };
}

/** 净值曲线 → 带时间戳的逐根收益（跳过 equityCurve 首点，它没有前值） */
export function timedReturnsFromEquity(
  points: { time: number; equity: number }[],
): { time: number; ret: number }[] {
  const out: { time: number; ret: number }[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].equity;
    if (prev > 0) out.push({ time: points[i].time, ret: points[i].equity / prev - 1 });
  }
  return out;
}
