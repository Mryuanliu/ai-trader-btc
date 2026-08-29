import { describe, expect, it } from 'vitest';
import { Candle, strategyRegistry, TrendFollowingStrategy } from '@ai-trader/shared';
import { runBacktest } from './engine';
import type { BacktestConfig } from './types';

/** 构造一根 K 线 */
function bar(time: number, open: number, close: number, volume = 100): Candle {
  const high = Math.max(open, close) * 1.001;
  const low = Math.min(open, close) * 0.999;
  return { time, open, high, low, close, volume };
}

/**
 * 震荡上行/下行段：收盘交替 +2/-1（或镜像），模拟真实走势——
 * 单边直线上涨会让 RSI 超买、布林上轨同时转空，信号互相抵消反而无法触发开仓
 */
function rising(count: number, start: number, step: number, t0: number): Candle[] {
  let close = start;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    const delta = i % 2 === 0 ? step : -step / 2;
    close = open + delta;
    return bar(t0 + i * 300_000, open, close);
  });
}

function config(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    from: 0,
    to: 0,
    initialCapital: 10_000,
    slippageBps: 0,
    feeRateBps: 0,
    positionPct: 0.5,
    minConfidence: 0.6,
    strategyName: 'trend_following',
    strategyParams: { entryThreshold: 0.25 },
    warmupBars: 150,
    ...over,
  };
}

/** 单调下跌段：每根跌 drop（用于触发止损） */
function crash(count: number, start: number, drop: number, t0: number): Candle[] {
  let close = start;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = open - drop;
    return bar(t0 + i * 300_000, open, close);
  });
}

function newStrategy() {
  // 与引擎同源：从注册表取用（未注册时兜底直接实例化）
  return strategyRegistry.get('trend_following') ?? new TrendFollowingStrategy();
}

describe('runBacktest · 出场规则（阶段4）', () => {
  it('止损触发：亏损达到阈值时全仓卖出，优先于策略信号', () => {
    // crash 起点衔接 rising 终点（~176）并跌破金字塔加仓的成本均价，止损才能触发
    const candles = [
      ...rising(210, 150, 0.5, 1_700_000_000_000),
      ...crash(10, 176, 3, 1_700_000_000_000 + 210 * 300_000),
    ];
    const report = runBacktest(candles, newStrategy(), config({ exitRules: { stopLossPct: 0.03 } }));

    const buys = report.trades.filter((t) => t.side === 'BUY');
    expect(buys.length).toBeGreaterThanOrEqual(1);
    // 出场单 confidence=1（策略卖出 <1），卖全部持仓且发生在暴跌段
    const stopSell = report.trades.find((t) => t.side === 'SELL' && t.decisionConfidence === 1);
    expect(stopSell).toBeDefined();
    expect(stopSell!.quantity).toBeGreaterThan(buys[0].quantity * 0.9);
    expect(stopSell!.time).toBeGreaterThan(candles[210].time);
  });

  it('止盈触发：盈利达到阈值时全仓卖出', () => {
    // 上涨触发 BUY → 继续上涨达到止盈
    const candles = rising(320, 100, 2, 1_700_000_000_000);
    const report = runBacktest(candles, newStrategy(), config({ exitRules: { takeProfitPct: 0.05 } }));

    const sells = report.trades.filter((t) => t.side === 'SELL');
    expect(sells.length).toBeGreaterThanOrEqual(1);
    // 出场单 confidence=1（策略卖出的置信度 <1）
    expect(sells.some((t) => t.decisionConfidence === 1)).toBe(true);
  });

  it('未配置出场规则时行为不变（默认全关）', () => {
    const candles = [
      ...rising(210, 150, 0.5, 1_700_000_000_000),
      ...crash(10, 176, 3, 1_700_000_000_000 + 210 * 300_000),
    ];
    const withExit = runBacktest(candles, newStrategy(), config({ exitRules: { stopLossPct: 0.03 } }));
    const withoutExit = runBacktest(candles, newStrategy(), config());
    // 出场单与策略单的卖出量不同（全仓 vs positionPct 部分），成交序列必然不同
    expect(withExit.trades).not.toEqual(withoutExit.trades);
  });
});
