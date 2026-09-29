import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import type { BacktestConfig } from '../backtest.types';
import { runBacktest } from '../backtest-runner';
import { TrendFollowingStrategy } from '../../strategy/trend-following.strategy';

/** 造一段有趋势切换的合成 K 线（sin 漂移 → EMA9/21 会反复金叉死叉，逼策略交易） */
function genCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = Math.sin(i / 15) * 0.8;
    const open = price;
    const close = Math.max(1, open + drift + ((i % 7) - 3) * 0.2);
    out.push({
      time: i * 300_000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: 1,
    });
    price = close;
  }
  return out;
}

function tempCandleFile(candles: Candle[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-'));
  const p = join(dir, 'candles.json');
  writeFileSync(p, JSON.stringify({ symbol: 'BTCUSDT', interval: '5m', candles }));
  return p;
}

function baseConfig(file: string): BacktestConfig {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    initialCapital: 10_000,
    warmupBars: 120,
    feeRateBps: 4,
    slippageBps: 10,
    fundingPctPer8h: 0,
    strategyName: 'trend_following',
    params: { baseQty: 1, cooldownSec: 0 },
    file,
  };
}

describe('runBacktest 回测台', () => {
  const candles = genCandles(400);
  const file = tempCandleFile(candles);

  it('同一输入两次跑出完全一致的结果（确定性/可复现）', async () => {
    const a = await runBacktest(new TrendFollowingStrategy(), baseConfig(file));
    const b = await runBacktest(new TrendFollowingStrategy(), baseConfig(file));
    expect(JSON.stringify(a.report.trades)).toEqual(JSON.stringify(b.report.trades));
    expect(a.report.metrics).toEqual(b.report.metrics);
  });

  it('净值曲线逐根覆盖，长度等于 K 线根数', async () => {
    const r = await runBacktest(new TrendFollowingStrategy(), baseConfig(file));
    expect(r.report.equityCurve).toHaveLength(candles.length);
    expect(r.report.meta.fillConvention).toBe('next-open');
  });

  it('预热期内不做任何决策：首笔成交不早于 warmup 边界', async () => {
    const r = await runBacktest(new TrendFollowingStrategy(), baseConfig(file));
    const warmupTime = candles[120].time;
    expect(r.report.trades.length).toBeGreaterThan(0);
    for (const t of r.report.trades) expect(t.time).toBeGreaterThanOrEqual(warmupTime);
  });

  it('指标齐备且口径与 basketMetrics 一致（sharpe 同源）', async () => {
    const r = await runBacktest(new TrendFollowingStrategy(), baseConfig(file));
    const m = r.report.metrics;
    expect(Number.isFinite(m.totalReturnPct)).toBe(true);
    expect(m.sharpeRatio).toBe(r.report.basketMetrics.sharpe);
    expect(m.winRate).toBe(r.report.basketMetrics.winRate);
  });
});
