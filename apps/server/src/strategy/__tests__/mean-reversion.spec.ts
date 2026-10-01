import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { MeanReversionStrategy } from '../mean-reversion.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

/**
 * 均值回归策略（B0）覆盖：
 * - 入场：跌破下轨 + RSI-2 超卖 → LONG；突破上轨 + RSI-2 超买 → SHORT
 * - 门控：趋势市（trendRatio > regimeMax）即使破轨也不开；带内不开；破轨但 RSI 未确认不开
 * - 仓位：useVolSizing 时 qty ∝ 1/atr
 * - 出场：回归中轨止盈 → ATR 硬止损 → 时间止损
 * - 冷却：平仓后 cooldownSec 内不开新仓
 * - warmup：收盘 K 线不足 → 跳过并等待数据
 *
 * 时间口径全部走 ctx.now；布林/RSI/regime 全部基于 candles.slice(0,-1)（最后一根视为未收盘被排除）。
 */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** 由收盘价序列构造 K 线（open=high=low=close，仅 close 参与计算） */
function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: T0 + i * HOUR,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

// 收盘段（slice(0,-1) 后即参与计算的那批）——额外补 1 根未收盘占位
// LONG：末段连续下跌 → RSI-2=0（超卖），且布林下轨≈85.87（mid≈95.2）
const LONG_CLOSED = [100, 100, 100, 100, 100, 96, 92, 88];
// SHORT：末段连续上涨 → RSI-2=100（超买），且布林上轨≈114.13（mid≈104.8）
const SHORT_CLOSED = [100, 100, 100, 100, 100, 104, 108, 112];
// FLAT：sd=0 → 上下轨重合于 100，任何带内 mark 都不破轨
const FLAT_CLOSED = [100, 100, 100, 100, 100, 100, 100, 100];

function makeLot(over: Partial<StrategyLotView> = {}): StrategyLotView {
  return {
    id: 'lot-1',
    direction: 'LONG',
    quantity: 0.5,
    entryPrice: 100,
    unrealizedPnl: 0,
    openedAt: new Date(T0).toISOString(),
    hasPendingClose: false,
    ...over,
  };
}

function makeExecutor() {
  const opens: { direction: string; quantity: number; leverage: number; reason: string }[] = [];
  const closes: { lotId: string; reason: string }[] = [];
  const executor: StrategyExecutor = {
    async openLot(input) {
      opens.push({
        direction: input.direction,
        quantity: input.quantity,
        leverage: input.leverage ?? 1,
        reason: input.reason,
      });
      return { lotId: `lot-${opens.length}` };
    },
    async closeLot(lotId, reason) {
      closes.push({ lotId, reason });
      return { ok: true };
    },
    async placeStopOrder() {
      return { orderId: 'x' };
    },
    async cancelOrder() {
      return { ok: true };
    },
  };
  return { executor, opens, closes };
}

/** 入场类公共参数：小窗布林 + RSI-2 + regime，固定 baseQty 便于断言 */
function entryParams(s: MeanReversionStrategy, over: Record<string, unknown> = {}) {
  return s.normalizeParams({
    bollingerPeriod: 5,
    bollingerK: 2,
    rsiPeriod: 2,
    rsiBuyMax: 10,
    rsiSellMin: 90,
    regimeEmaFast: 2,
    regimeEmaSlow: 3,
    regimeMax: 0.5,
    useVolSizing: false,
    baseQty: 0.01,
    maxHoldBars: 10_000, // 默认关时间止损
    cooldownSec: 0,
    ...over,
  });
}

function makeContext(
  overrides: Partial<StrategyContext> & { params: Record<string, unknown> },
): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    instanceId: 'mean_reversion:BTCUSDT',
    price: 84,
    markPrice: 84,
    atr: 200,
    candles: makeCandles([...LONG_CLOSED, 88]),
    openLots: [],
    openOrders: [],
    availableMargin: 10_000,
    netQty: 0,
    now: T0 + 30 * HOUR,
    ...overrides,
  };
}

describe('MeanReversionStrategy · 入场', () => {
  it('跌破下轨 + RSI-2 超卖 + 震荡 regime → 开 LONG', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    // closed=LONG_CLOSED，mid≈95.2 lower≈85.87，mark=84 < lower；rsi=0 ≤ 10；atr=200 → trendRatio≈0.008 震荡
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200 }),
      executor,
    );
    expect(opens).toHaveLength(1);
    expect(opens[0].direction).toBe('LONG');
    expect(opens[0].quantity).toBeCloseTo(0.01, 8);
    expect(opens[0].reason).toBe('mean-reversion');
  });

  it('突破上轨 + RSI-2 超买 + 震荡 → 开 SHORT', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    // closed=SHORT_CLOSED，mid≈104.8 upper≈114.13，mark=116 > upper；rsi=100 ≥ 90
    await s.onTick(
      makeContext({ params, candles: makeCandles([...SHORT_CLOSED, 112]), markPrice: 116, price: 116, atr: 200 }),
      executor,
    );
    expect(opens).toHaveLength(1);
    expect(opens[0].direction).toBe('SHORT');
  });

  it('趋势市（trendRatio > regimeMax）→ 即使破轨也不开仓', async () => {
    const s = new MeanReversionStrategy();
    // regimeMax=0：任何非零趋势强度都判为趋势市；atr=1 → trendRatio≈1.57 > 0
    const params = entryParams(s, { regimeMax: 0 });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 1 }),
      executor,
    );
    expect(opens).toHaveLength(0);
  });

  it('价格在带内（未破轨）→ 不开仓', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    // FLAT：sd=0 → 上下轨=mid=100，mark=100 不破轨
    await s.onTick(
      makeContext({ params, candles: makeCandles([...FLAT_CLOSED, 100]), markPrice: 100, price: 100, atr: 200 }),
      executor,
    );
    expect(opens).toHaveLength(0);
  });

  it('破下轨但 RSI-2 未超卖（> rsiBuyMax）→ 不开仓（双确认生效）', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    // closed 末两根上涨 → RSI-2=100（不超卖）；但 mark=50 < 下轨 56
    const closed = [100, 100, 100, 70, 70, 90, 110];
    await s.onTick(
      makeContext({ params, candles: makeCandles([...closed, 110]), markPrice: 50, price: 50, atr: 200 }),
      executor,
    );
    expect(opens).toHaveLength(0);
  });

  it('useVolSizing=true：qty ∝ 1/atr（atr 翻倍 → qty 减半）', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s, { useVolSizing: true, riskPerTradePct: 0.5 });
    s.onStart?.(params);

    const a = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200 }),
      a.executor,
    );
    const b = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 400 }),
      b.executor,
    );
    const qtyA = a.opens[0]?.quantity ?? 0;
    const qtyB = b.opens[0]?.quantity ?? 0;
    expect(qtyA).toBeGreaterThan(0);
    expect(qtyB).toBeGreaterThan(0);
    expect(qtyB / qtyA).toBeCloseTo(0.5, 6);
  });
});

describe('MeanReversionStrategy · 出场', () => {
  it('持仓 LONG 且 mark 回到中轨 → TAKE_PROFIT', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);

    // tick1：开 LONG（mid≈95.2 lower≈85.87 快照入 entryRefs）
    const e1 = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200 }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);

    // tick2：mark=100 ≥ 中轨 95.2 → 止盈
    const e2 = makeExecutor();
    await s.onTick(
      makeContext({
        params,
        candles: makeCandles([...LONG_CLOSED, 88]),
        markPrice: 100,
        price: 100,
        atr: 200,
        openLots: [makeLot({ id: 'lot-1', direction: 'LONG' })],
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(1);
    expect(e2.closes[0].reason).toBe('TAKE_PROFIT');
  });

  it('持仓 LONG 且 mark 跌破 下轨 − stopAtrMult·ATR → STOP_LOSS', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s, { stopAtrMult: 2 });
    s.onStart?.(params);

    const e1 = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200 }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);

    // tick2：atr=1 → 止损线 = lower(85.87) - 2*1 = 83.87；mark=80 < 83.87 且 < mid → 止损
    const e2 = makeExecutor();
    await s.onTick(
      makeContext({
        params,
        candles: makeCandles([...LONG_CLOSED, 88]),
        markPrice: 80,
        price: 80,
        atr: 1,
        openLots: [makeLot({ id: 'lot-1', direction: 'LONG' })],
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(1);
    expect(e2.closes[0].reason).toBe('STOP_LOSS');
  });

  it('持仓超 maxHoldBars 根 → 时间止损 SIGNAL', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s, { maxHoldBars: 3 });
    s.onStart?.(params);

    const now1 = T0 + 30 * HOUR;
    const e1 = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200, now: now1 }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);

    // tick2：mark=90（< mid 95.2 不止盈；> lower-stop 不止损）；持仓 3 根 → 时间止损
    const e2 = makeExecutor();
    await s.onTick(
      makeContext({
        params,
        candles: makeCandles([...LONG_CLOSED, 88]),
        markPrice: 90,
        price: 90,
        atr: 200,
        openLots: [makeLot({ id: 'lot-1', direction: 'LONG' })],
        now: now1 + 3 * HOUR,
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(1);
    expect(e2.closes[0].reason).toBe('SIGNAL');
  });
});

describe('MeanReversionStrategy · 冷却 & warmup', () => {
  it('平仓后 cooldownSec 内即使满足入场条件也不开新仓', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s, { cooldownSec: 3600 });
    s.onStart?.(params);

    const now1 = T0 + 30 * HOUR;
    const now2 = now1 + HOUR;
    // tick1：开 LONG
    const e1 = makeExecutor();
    await s.onTick(
      makeContext({ params, candles: makeCandles([...LONG_CLOSED, 88]), markPrice: 84, price: 84, atr: 200, now: now1 }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);

    // tick2：TP 平仓（mark=100 ≥ mid）→ lastCloseAt=now2
    const e2 = makeExecutor();
    await s.onTick(
      makeContext({
        params,
        candles: makeCandles([...LONG_CLOSED, 88]),
        markPrice: 100,
        price: 100,
        atr: 200,
        openLots: [makeLot({ id: 'lot-1', direction: 'LONG' })],
        now: now2,
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(1);

    // tick3：冷却中（now2 + 60s < 3600s）即使破轨+超卖也不开
    const e3 = makeExecutor();
    await s.onTick(
      makeContext({
        params,
        candles: makeCandles([...LONG_CLOSED, 88]),
        markPrice: 84,
        price: 84,
        atr: 200,
        now: now2 + 60_000,
      }),
      e3.executor,
    );
    expect(e3.opens).toHaveLength(0);
  });

  it('收盘 K 线不足 warmup → 跳过并提示等待数据', async () => {
    const s = new MeanReversionStrategy();
    const params = entryParams(s);
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    // closed 仅 3 根 < warmup(=max(5,3,3))+1=6
    await s.onTick(
      makeContext({ params, candles: makeCandles([100, 100, 100, 100]), markPrice: 84, price: 84, atr: 200 }),
      executor,
    );
    expect(opens).toHaveLength(0);
    expect(String(s.getState().note)).toContain('K 线不足');
  });
});
