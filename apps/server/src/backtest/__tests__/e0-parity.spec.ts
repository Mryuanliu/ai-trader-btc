/**
 * E0 语料级回归：新策略（全开关关=老策略逐位一致）vs 老策略 —— 同语料回测 diff=0。
 *
 * 验证不变量 C-1 parity：关断态（useBrain/useScoreSizing/usePendingDiscipline/useExitChain/
 * usePivotCarry/useExtremeGuard 全 false）下，martingale_grid_v2 产出的
 * trades / equityCurve / metrics 与 martingale_grid 完全一致。
 */
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { TIMEFRAME_MS } from '@ai-trader/shared';
import type { BacktestConfig } from '../backtest.types';
import { runBacktestOnCandles } from '../backtest-runner';
import { MartingaleGridStrategy } from '../../strategy/martingale-grid.strategy';
import { MartingaleGridV2Strategy } from '../../strategy/martingale-grid-v2.strategy';

/**
 * 合成 K 线：正弦+锯齿混合，价格范围约 96k-104k，确保触发多层网格 STOP 和篮子追踪。
 * 1200 根 1m ≈ 20 小时，预热 200 根后仍剩 1000 根可交易——足以产生多轮完整篮子。
 */
function genOscillatingCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100_000;
  for (let i = 0; i < n; i += 1) {
    const wave = Math.sin(i / 40) * 1500 + Math.sin(i / 13) * 800;
    const target = 100_000 + wave;
    // 向 target 靠拢：每根最多移动 300
    const step = Math.sign(target - price) * Math.min(Math.abs(target - price), 300);
    const open = price;
    const close = open + step;
    const spread = 120; // bar 高低价扩展
    out.push({
      time: 1_700_000_000_000 + i * TIMEFRAME_MS['1m'],
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 10,
    });
    price = close;
  }
  return out;
}

function baseConfig(strategyName: string): BacktestConfig {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    from: undefined,
    to: undefined,
    initialCapital: 10_000,
    warmupBars: 200,
    feeRateBps: 4,
    slippageBps: 5,
    fundingPctPer8h: 0,
    strategyName,
    // 老 20 参用策略自身 DEFAULT_PARAMS 即可（空对象→normalizeParams 取默认）；
    // useTrendFilter=false 确保双向挂单（更多成交路径），便于暴露差异
    params: { useTrendFilter: false },
    file: undefined,
  };
}

describe('E0 语料级回测回归（全开关关 = 老策略 diff=0）', () => {
  const candles = genOscillatingCandles(1200);

  it('trades / equityCurve / metrics 逐位一致', async () => {
    const old = new MartingaleGridStrategy();
    const v2 = new MartingaleGridV2Strategy();

    const cfgOld = baseConfig('martingale_grid');
    const cfgV2 = baseConfig('martingale_grid_v2');

    const resOld = await runBacktestOnCandles(old, cfgOld, candles);
    const resV2 = await runBacktestOnCandles(v2, cfgV2, candles);

    // 逐笔成交一致
    expect(resV2.report.trades).toEqual(resOld.report.trades);

    // 净值曲线逐根一致
    expect(resV2.report.equityCurve).toEqual(resOld.report.equityCurve);

    // 汇总指标一致
    expect(resV2.report.metrics).toEqual(resOld.report.metrics);

    // 成本分解一致
    expect(resV2.report.costBreakdown).toEqual(resOld.report.costBreakdown);

    // 篮子绩效一致（排除 strategyName 字段，两策略名不同属预期差异）
    const { strategyName: _sn1, ...bmOld } = resOld.report.basketMetrics;
    const { strategyName: _sn2, ...bmV2 } = resV2.report.basketMetrics;
    expect(bmV2).toEqual(bmOld);
  }, 30_000);

  it('多次运行确定性（同输入同输出）', async () => {
    const v2a = new MartingaleGridV2Strategy();
    const v2b = new MartingaleGridV2Strategy();
    const cfg = baseConfig('martingale_grid_v2');

    const resA = await runBacktestOnCandles(v2a, cfg, candles);
    const resB = await runBacktestOnCandles(v2b, cfg, candles);

    expect(resA.report.trades).toEqual(resB.report.trades);
    expect(resA.report.equityCurve).toEqual(resB.report.equityCurve);
    expect(resA.report.metrics).toEqual(resB.report.metrics);
  }, 30_000);
});
