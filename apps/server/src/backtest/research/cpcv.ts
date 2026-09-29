import {
  TIMEFRAME_MS,
  type BacktestConfig,
  type Candle,
  type CpcvResult,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';
import { annualizeSharpe, mean, perBarReturns, quantile, sharpePerBar, std } from './stats';

const MAX_COMBOS = 200;

/** 从 [0,n) 里取 k 的所有组合（k 较小时够用） */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - i + 1)) / i;
  return Math.round(r);
}

export interface CpcvOptions {
  /** 折数 K，默认 5 */
  nFoldK?: number;
  /** 每组测试折数 k，默认 1 */
  testFoldSize?: number;
  /** 每折测试区起始丢弃的 bar 数（跨折边界缓冲），默认 0 */
  embargoBars?: number;
}

/**
 * CPCV（Combinatorial Purged K-Fold）在本平台的形态：
 * 把决策区切成 K 个连续折，枚举「留 k 折当测试」的所有组合，对每种留法把各测试折
 * （每折独立 fresh 实例 + warmup 前缀，杜绝指标前视）的逐根收益拼成一条 OOS 路径，
 * 得到该组合的 OOS 夏普；所有组合构成**夏普分布**，看策略在任意样本外切法下是否稳健。
 *
 * 因策略不含「拟合状态」，purge/embargo 主要靠每折自带 warmup 前缀隔离；
 * 仍保留 embargoBars 供跨折边界保守裁剪。
 */
export async function cpcv(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  opts: CpcvOptions = {},
): Promise<CpcvResult> {
  const warmup = base.warmupBars;
  const K = Math.max(2, opts.nFoldK ?? 5);
  const k = Math.max(1, Math.min(opts.testFoldSize ?? 1, K - 1));
  const embargo = Math.max(0, opts.embargoBars ?? 0);
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[base.interval];

  const region = candles.length - warmup;
  if (region < K * 2) {
    throw new Error(`决策区仅 ${region} 根，不足以切 ${K} 折 CPCV`);
  }
  const foldSize = Math.floor(region / K);

  let combos = combinations(K, k);
  if (combos.length > MAX_COMBOS) {
    const step = Math.ceil(combos.length / MAX_COMBOS);
    combos = combos.filter((_, i) => i % step === 0);
  }

  const oosSharpes: number[] = [];
  for (const combo of combos) {
    const rets: number[] = [];
    for (const f of combo) {
      const rStart = f * foldSize;
      const rEnd = f === K - 1 ? region : (f + 1) * foldSize;
      const absStart = warmup + rStart;
      const absEnd = warmup + rEnd;
      if (absEnd - absStart <= warmup) continue;
      const slice = candles.slice(Math.max(0, absStart - warmup), absEnd);
      const res = await runBacktestOnCandles(createStrategy(strategyName), { ...base }, slice);
      const foldRets = perBarReturns(res.report.equityCurve.slice(warmup).map((p) => p.equity));
      rets.push(...foldRets.slice(embargo));
    }
    if (rets.length > 1) {
      oosSharpes.push(Number(annualizeSharpe(sharpePerBar(rets), barsPerYear).toFixed(6)));
    }
  }

  return {
    nCombos: binom(K, k),
    oosSharpes,
    mean: Number(mean(oosSharpes).toFixed(6)),
    std: Number(std(oosSharpes).toFixed(6)),
    min: Number(Math.min(...oosSharpes).toFixed(6)),
    max: Number(Math.max(...oosSharpes).toFixed(6)),
    quantiles: [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => Number(quantile(oosSharpes, q).toFixed(6))),
  };
}
