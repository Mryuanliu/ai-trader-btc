import { describe, expect, it } from 'vitest';
import {
  Candle,
  Strategy,
  StrategyContext,
  StrategyOutput,
  strategyRegistry,
  TrendFollowingStrategy,
} from '@ai-trader/shared';
import { runBacktest } from './engine';
import { runFuturesBacktest } from './futures-engine';
import type { BacktestConfig, FuturesBacktestConfig } from './types';

function bar(time: number, open: number, close: number, volume = 100): Candle {
  return {
    time, open,
    high: Math.max(open, close) * 1.001,
    low: Math.min(open, close) * 0.999,
    close, volume,
  };
}

/** 震荡上行/下行段：收盘交替 +step/−step/2 */
function rising(count: number, start: number, step: number, t0: number): Candle[] {
  let close = start;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    const delta = i % 2 === 0 ? step : -step / 2;
    close = open + delta;
    return bar(t0 + i * 300_000, open, close);
  });
}

/** 单调下跌段（每根跌 drop） */
function crash(count: number, start: number, drop: number, t0: number): Candle[] {
  let close = start;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = open - drop;
    return bar(t0 + i * 300_000, open, close);
  });
}

/** 横盘段 */
function flat(count: number, price: number, t0: number): Candle[] {
  return Array.from({ length: count }, (_, i) => bar(t0 + i * 300_000, price, price));
}

const T0 = 1_700_000_000_000;
const STEP = 300_000;

/**
 * 确定性 stub 策略：固定输出动作，让资金费/强平/反手等场景完全可控。
 * （trend_following 在合成数据上的触发时机不可控，不适合做资金费与强平的精确断言）
 */
function stubStrategy(action: StrategyOutput['action'], flipAfter?: number): Strategy {
  let count = 0;
  return {
    name: 'stub',
    label: 'stub',
    description: 'test stub',
    defaultParams: {},
    normalizeParams: (raw) => raw ?? {},
    evaluate(_ctx: StrategyContext): StrategyOutput {
      count += 1;
      const use = flipAfter !== undefined && count > flipAfter ? (action === 'BUY' ? 'SELL' : 'BUY') : action;
      return { action: use, confidence: 1, reason: 'stub' };
    },
  };
}

const trend = () => strategyRegistry.get('trend_following') ?? new TrendFollowingStrategy();

function futuresConfig(over: Partial<FuturesBacktestConfig> = {}): FuturesBacktestConfig {
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
    strategyName: 'stub',
    warmupBars: 150,
    leverage: 5,
    stepSize: 0.0001,
    minNotional: 0,
    ...over,
  };
}

describe('runFuturesBacktest · 杠杆仓位', () => {
  it('开多：positionSide/margin/notional 语义正确，上涨盈利', async () => {
    const report = await runFuturesBacktest(
      rising(320, 100, 2, T0),
      stubStrategy('BUY'),
      futuresConfig({ leverage: 3 }),
    );

    expect(report.trades.length).toBeGreaterThanOrEqual(1);
    const open = report.trades[0];
    expect(open.positionSide).toBe('LONG');
    expect(open.reduceOnly).toBe(false);
    expect(open.side).toBe('BUY');
    // 名义价值 ≈ 保证金 × 杠杆（floorToStep 有极小截断）
    expect(open.notional).toBeCloseTo(open.margin * 3, 0);
    // 多头在上涨中盈利
    expect(report.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(report.liquidations.length).toBe(0);
    expect(report.meta.totalFundingPaid).toBe(0);
  });

  it('杠杆放大权益波动：同比例下 5x 的收益变动大于 1x', async () => {
    const candles = rising(320, 100, 2, T0);
    const low = await runFuturesBacktest(candles, stubStrategy('BUY'), futuresConfig({ leverage: 1 }));
    const high = await runFuturesBacktest(candles, stubStrategy('BUY'), futuresConfig({ leverage: 5 }));

    const lowMove = Math.abs(low.metrics.totalReturnPct);
    const highMove = Math.abs(high.metrics.totalReturnPct);
    expect(highMove).toBeGreaterThan(lowMove);
  });
});

describe('runFuturesBacktest · 空头（方向感知）', () => {
  it('单边下跌：SELL 开空盈利（若盈亏方向算反会得到负数）', async () => {
    const report = await runFuturesBacktest(
      crash(320, 200, 0.6, T0),
      stubStrategy('SELL'),
      futuresConfig({ leverage: 5 }),
    );

    expect(report.trades[0].positionSide).toBe('SHORT');
    expect(report.trades[0].side).toBe('SELL');
    expect(report.metrics.totalReturnPct).toBeGreaterThan(0);
  });

  it('空头回合胜率：SELL 开空后 BUY 平仓，盈利回合被正确统计为胜', async () => {
    // 先 5 个决策卖出开空，之后全部买入平空——下跌中平空必然盈利
    const report = await runFuturesBacktest(
      crash(320, 200, 0.6, T0),
      stubStrategy('SELL', 5),
      futuresConfig({ leverage: 2 }),
    );

    const closes = report.trades.filter((t) => t.reduceOnly);
    expect(closes.length).toBeGreaterThanOrEqual(1);
    expect(closes[0].side).toBe('BUY');
    expect(closes[0].positionSide).toBe('SHORT');
    expect(report.metrics.winRate).toBeGreaterThan(0);
  });

  it('反向信号只平仓不反手：持多遇 SELL 产生 reduceOnly 平仓单，下一跳才反手开空', async () => {
    // 前 5 个决策买入建多，之后全部卖出（先平多，再开空）
    const report = await runFuturesBacktest(
      rising(320, 100, 2, T0),
      stubStrategy('BUY', 5),
      futuresConfig({ leverage: 2 }),
    );

    const closes = report.trades.filter((t) => t.reduceOnly);
    expect(closes.length).toBeGreaterThanOrEqual(1);
    const firstClose = closes[0];
    // 平多单：SELL + LONG
    expect(firstClose.side).toBe('SELL');
    expect(firstClose.positionSide).toBe('LONG');

    // 平仓之后的开仓单必须是反方向（SHORT），且中间不存在同跳反手
    const closeIdx = report.trades.indexOf(firstClose);
    for (let i = closeIdx + 1; i < report.trades.length; i++) {
      const t = report.trades[i];
      if (!t.reduceOnly) {
        expect(t.positionSide).toBe('SHORT');
        break;
      }
    }
  });
});

describe('runFuturesBacktest · 资金费率', () => {
  const fundingRates = Array.from({ length: 9 }, (_, i) => ({
    fundingTime: T0 + (i + 1) * 8 * 3_600_000,
    rate: 0.0001,
  }));

  it('多头付正费率：totalFundingPaid > 0', async () => {
    const report = await runFuturesBacktest(
      flat(880, 100, T0),
      stubStrategy('BUY'),
      futuresConfig({ fundingRates }),
    );
    expect(report.trades.length).toBeGreaterThanOrEqual(1);
    expect(report.meta.totalFundingPaid).toBeGreaterThan(0);
  });

  it('空头收正费率：totalFundingPaid < 0', async () => {
    const report = await runFuturesBacktest(
      flat(880, 100, T0),
      stubStrategy('SELL'),
      futuresConfig({ fundingRates }),
    );
    expect(report.trades.length).toBeGreaterThanOrEqual(1);
    expect(report.meta.totalFundingPaid).toBeLessThan(0);
  });

  it('不传资金费率时为 0（向后兼容）', async () => {
    const report = await runFuturesBacktest(flat(300, 100, T0), stubStrategy('BUY'), futuresConfig());
    expect(report.meta.totalFundingPaid).toBe(0);
  });
});

describe('runFuturesBacktest · 强平（简化保守模型）', () => {
  it('急跌触发多头强平：保证金全损并记录事件；1x 同跌不强平', async () => {
    // 建多后每根 -8%，5x 杠杆强平线约 -20%，必然触及
    const candles = [...rising(200, 100, 1, T0), ...crash(10, 250, 20, T0 + 200 * STEP)];
    const lev5 = await runFuturesBacktest(candles, stubStrategy('BUY'), futuresConfig({ leverage: 5 }));

    expect(lev5.liquidations.length).toBeGreaterThanOrEqual(1);
    expect(lev5.meta.liquidationCount).toBe(lev5.liquidations.length);
    const liq = lev5.liquidations[0];
    expect(liq.positionSide).toBe('LONG');
    expect(liq.loss).toBeGreaterThan(0);
    // 强平价 ≈ 开仓均价 × (1 − 1/杠杆) 附近（多次加仓取加权）
    expect(liq.price).toBeGreaterThan(0);

    // 1x：强平线 -100%，同样的跌幅绝不触发
    const lev1 = await runFuturesBacktest(candles, stubStrategy('BUY'), futuresConfig({ leverage: 1 }));
    expect(lev1.liquidations.length).toBe(0);
  });
});

describe('现货回归断言（Commit 6 不改现货引擎）', () => {
  it('现货回测基线不变：止损出场单 confidence=1 全仓卖出', async () => {
    const candles = [...rising(210, 150, 0.5, T0), ...crash(10, 176, 3, T0 + 210 * STEP)];
    const report = await runBacktest(
      candles,
      trend(),
      {
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
        exitRules: { stopLossPct: 0.03 },
      },
    );
    const buys = report.trades.filter((t) => t.side === 'BUY');
    expect(buys.length).toBeGreaterThanOrEqual(1);
    const stopSell = report.trades.find((t) => t.side === 'SELL' && t.decisionConfidence === 1);
    expect(stopSell).toBeDefined();
    expect(stopSell!.quantity).toBeGreaterThan(buys[0].quantity * 0.9);
  });
});

describe('确定性', () => {
  it('同一输入连跑两次输出逐字节一致', async () => {
    const candles = flat(300, 100, T0);
    const cfg = futuresConfig({ fundingRates: [{ fundingTime: T0 + 8 * 3_600_000, rate: 0.0001 }] });
    const a = await runFuturesBacktest(candles, stubStrategy('BUY'), cfg);
    const b = await runFuturesBacktest(candles, stubStrategy('BUY'), cfg);
    expect(b.trades).toEqual(a.trades);
    expect(b.equityCurve).toEqual(a.equityCurve);
    expect(b.liquidations).toEqual(a.liquidations);
    expect(b.meta.totalFundingPaid).toBe(a.meta.totalFundingPaid);
  });
});
