import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { MartingaleGridStrategy } from '../martingale-grid.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

/** 平盘 K 线：够算 ATR 与均线，且趋势评分为 0 */
function makeCandles(price = 100_000, count = 80): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: price,
    high: price + 50,
    low: price - 50,
    close: price,
    volume: 1,
  }));
}

function makeLot(overrides: Partial<StrategyLotView> = {}): StrategyLotView {
  return {
    id: 'lot-1',
    direction: 'LONG',
    quantity: 0.001,
    entryPrice: 100_000,
    unrealizedPnl: 0,
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 记录策略实际发出的交易动作，用于断言 */
function makeExecutor() {
  const stops: { direction: string; stopPrice: number; quantity: number }[] = [];
  const closes: { lotId: string; reason: string }[] = [];
  const cancels: string[] = [];
  const executor: StrategyExecutor = {
    async openLot() {
      return { lotId: 'lot-new' };
    },
    async closeLot(lotId, reason) {
      closes.push({ lotId, reason });
      return { ok: true };
    },
    async placeStopOrder(input) {
      stops.push({
        direction: input.direction,
        stopPrice: input.stopPrice,
        quantity: input.quantity,
      });
      return { orderId: `ord-${stops.length}` };
    },
    async cancelOrder(orderId) {
      cancels.push(orderId);
      return { ok: true };
    },
  };
  return { executor, stops, closes, cancels };
}

function makeContext(
  strategy: MartingaleGridStrategy,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    price: 100_000,
    atr: 100,
    candles: makeCandles(),
    openLots: [],
    openOrders: [],
    availableMargin: 5000,
    netQty: 0,
    params: strategy.normalizeParams(),
    now: Date.now(),
    ...overrides,
  };
}

describe('MartingaleGridStrategy · 参数归一化', () => {
  const strategy = new MartingaleGridStrategy();

  it('非法值回落默认、越界值被钳制', () => {
    const p = strategy.normalizeParams({
      lotMultiplier: 99,
      maxLayersPerSide: 100,
      leverage: 0,
      enabledSides: 'sideways',
    });
    expect(p.lotMultiplier).toBe(3); // 上限
    expect(p.maxLayersPerSide).toBe(12); // 上限
    expect(p.leverage).toBe(1); // 下限
    expect(p.enabledSides).toBe('both'); // 非法枚举回落
  });

  it('空参数使用默认值（每侧 6 层、倍率 1.5）', () => {
    const p = strategy.normalizeParams(null);
    expect(p.maxLayersPerSide).toBe(6);
    expect(p.lotMultiplier).toBe(1.5);
  });

  it('策略永不因参数崩溃：字符串/NaN 一律回落', () => {
    const p = strategy.normalizeParams({ baseQty: 'abc', basketStartPct: Number.NaN } as never);
    expect(Number.isFinite(p.baseQty as number)).toBe(true);
    expect(Number.isFinite(p.basketStartPct as number)).toBe(true);
  });
});

describe('MartingaleGridStrategy · 首层挂单（EA 语义）', () => {
  it('无持仓时双向挂 STOP：多在上方、空在下方', async () => {
    const strategy = new MartingaleGridStrategy();
    // 关闭单侧金字塔过滤，才能同时观察两侧行为
    const params = strategy.normalizeParams({ useTrendFilter: false, firstStepAtrMult: 1 });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    await strategy.onTick(makeContext(strategy, { params }), executor);

    expect(stops).toHaveLength(2);
    const long = stops.find((s) => s.direction === 'LONG');
    const short = stops.find((s) => s.direction === 'SHORT');
    // BUY 挂在上方（突破买入）、SELL 挂在下方（破位卖出）
    expect(long!.stopPrice).toBeGreaterThan(100_000);
    expect(short!.stopPrice).toBeLessThan(100_000);
    // 手数 = 首层数量
    expect(long!.quantity).toBeCloseTo(params.baseQty as number, 8);
  });

  it('已有挂单时不重复挂（每次只保留一层待成交）', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({ useTrendFilter: false });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    await strategy.onTick(
      makeContext(strategy, {
        params,
        openOrders: [
          {
            id: 'existing',
            side: 'BUY',
            type: 'STOP_MARKET',
            stopPrice: 100_100,
            quantity: 0.001,
            exchangeOrderId: 'ex-1',
          },
        ],
      }),
      executor,
    );

    expect(stops.filter((s) => s.direction === 'LONG')).toHaveLength(0);
    // 空头侧无挂单，照常挂出
    expect(stops.filter((s) => s.direction === 'SHORT')).toHaveLength(1);
  });

  it('达到每侧层数上限后不再加层', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({ useTrendFilter: false, maxLayersPerSide: 6 });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    const lots = Array.from({ length: 6 }, (_, i) =>
      makeLot({ id: `lot-${i}`, entryPrice: 100_000 + i * 100 }),
    );
    await strategy.onTick(makeContext(strategy, { params, openLots: lots }), executor);

    expect(stops.filter((s) => s.direction === 'LONG')).toHaveLength(0);
  });

  it('价格未走远时加层被抑制（EA 的「等回归确认」语义）', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({
      useTrendFilter: false,
      stepAtrMult: 1,
      minStepPct: 0.002,
      maxStepPct: 0.03,
    });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    // 现价 100000，最不利持仓 99900，间距约 200（ATR × 1 且被 0.2% 下限抬到 200）
    // 100000 > 99900 − 2×200 = 99500 → 未走远，不应加层
    await strategy.onTick(
      makeContext(strategy, { params, openLots: [makeLot({ entryPrice: 99_900 })] }),
      executor,
    );

    expect(stops.filter((s) => s.direction === 'LONG')).toHaveLength(0);
  });
});

describe('MartingaleGridStrategy · 篮子追踪止盈（EA 的唯一出场）', () => {
  it('达到启动阈值后回撤超过 giveback 即全平', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({
      useTrendFilter: false,
      basketStartPct: 0.015,
      basketGivebackPct: 0.005,
      basketStopLossPct: 0,
    });
    strategy.onStart?.(params);
    const { executor, closes } = makeExecutor();

    const lot = makeLot({ quantity: 0.001, entryPrice: 100_000 }); // 名义 100 USDT

    // 第一跳：净收益 4.95% → 刷新峰值，未回撤，不平仓
    await strategy.onTick(
      makeContext(strategy, { params, openLots: [{ ...lot, unrealizedPnl: 5 }] }),
      executor,
    );
    expect(closes).toHaveLength(0);
    expect((strategy.getState().basketPeakPct as number)).toBeGreaterThan(0.04);

    // 第二跳：净收益降到 3.95%，回撤 1% ≥ 0.5% → 触发篮子止盈
    await strategy.onTick(
      makeContext(strategy, { params, openLots: [{ ...lot, unrealizedPnl: 4 }] }),
      executor,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ lotId: 'lot-1', reason: 'TAKE_PROFIT' });
  });

  it('篮子止损：净亏损超过阈值即全平', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({
      useTrendFilter: false,
      basketStopLossPct: 0.02,
    });
    strategy.onStart?.(params);
    const { executor, closes } = makeExecutor();

    // 名义 100，浮亏 −2.5 → 净约 −2.55% < −2% → 止损
    await strategy.onTick(
      makeContext(strategy, { params, openLots: [makeLot({ unrealizedPnl: -2.5 })] }),
      executor,
    );

    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe('STOP_LOSS');
  });

  it('出场前先撤掉未成交挂单，避免残单', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({ useTrendFilter: false, basketStopLossPct: 0.02 });
    strategy.onStart?.(params);
    const { executor, cancels } = makeExecutor();

    await strategy.onTick(
      makeContext(strategy, {
        params,
        openLots: [makeLot({ unrealizedPnl: -5 })],
        openOrders: [
          {
            id: 'pending-1',
            side: 'BUY',
            type: 'STOP_MARKET',
            stopPrice: 100_100,
            quantity: 0.001,
            exchangeOrderId: 'ex-1',
          },
        ],
      }),
      executor,
    );

    expect(cancels).toEqual(['pending-1']);
  });

  it('低于启动阈值的浮盈不平仓', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({
      useTrendFilter: false,
      basketStartPct: 0.015,
    });
    strategy.onStart?.(params);
    const { executor, closes } = makeExecutor();

    // 净收益约 0.45%，远低于 1.5% 启动阈值
    await strategy.onTick(
      makeContext(strategy, { params, openLots: [makeLot({ unrealizedPnl: 0.5 })] }),
      executor,
    );

    expect(closes).toHaveLength(0);
  });
});

describe('MartingaleGridStrategy · 单侧金字塔（EA 趋势过滤）', () => {
  it('已持多单侧时不再挂空头侧挂单', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({ useTrendFilter: true });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    await strategy.onTick(
      makeContext(strategy, { params, openLots: [makeLot({ direction: 'LONG' })] }),
      executor,
    );

    expect(stops.filter((s) => s.direction === 'SHORT')).toHaveLength(0);
  });

  it('enabledSides=longOnly 时不产生空头挂单', async () => {
    const strategy = new MartingaleGridStrategy();
    const params = strategy.normalizeParams({ useTrendFilter: false, enabledSides: 'longOnly' });
    strategy.onStart?.(params);
    const { executor, stops } = makeExecutor();

    await strategy.onTick(makeContext(strategy, { params }), executor);

    expect(stops.every((s) => s.direction === 'LONG')).toBe(true);
  });
});
