import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { DonchianBreakoutStrategy } from '../donchian-breakout.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

/**
 * 唐奇安突破策略覆盖：
 * - 入场：上破 max(high) → LONG；下破 min(low) → SHORT；通道内 → 不开
 * - 出场：反向通道破位（SIGNAL）优先；吊灯单调；时间止损按 bar 数触发
 * - 仓位：useVolSizing=true 走定标；false 走 baseQty
 * - 冷却：平仓后 cooldownSec 内即使条件满足也不开新仓
 */

/** 造单调上涨的 K 线：i 递增 → high/low/close 都递增 */
function makeRisingCandles(n: number, startPrice = 100_000, slope = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const price = startPrice + i * slope;
    return {
      time: 1_700_000_000_000 + i * 3_600_000, // 1h
      open: price,
      high: price + slope,
      low: price - slope,
      close: price + slope / 2,
      volume: 1,
    };
  });
}

/** 横盘 K 线：所有 high/low 都一样，突破必须严格越界 */
function makeFlatCandles(n: number, price = 100_000, wick = 50): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000_000 + i * 3_600_000,
    open: price,
    high: price + wick,
    low: price - wick,
    close: price,
    volume: 1,
  }));
}

function makeLot(over: Partial<StrategyLotView> = {}): StrategyLotView {
  return {
    id: 'lot-1',
    direction: 'LONG',
    quantity: 0.5,
    entryPrice: 100_000,
    unrealizedPnl: 0,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    hasPendingClose: false,
    ...over,
  };
}

function makeExecutor() {
  const opens: { direction: string; quantity: number; leverage: number }[] = [];
  const closes: { lotId: string; reason: string }[] = [];
  const executor: StrategyExecutor = {
    async openLot(input) {
      opens.push({
        direction: input.direction,
        quantity: input.quantity,
        leverage: input.leverage ?? 1,
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

function makeContext(
  strategy: DonchianBreakoutStrategy,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    instanceId: 'donchian_breakout:BTCUSDT',
    price: 100_000,
    markPrice: 100_000,
    atr: 200,
    candles: makeRisingCandles(30),
    openLots: [],
    openOrders: [],
    availableMargin: 10_000,
    netQty: 0,
    params: strategy.normalizeParams(),
    now: 1_700_000_000_000 + 30 * 3_600_000,
    ...overrides,
  };
}

describe('DonchianBreakoutStrategy · 入场通道', () => {
  it('上破 max(high) → 开 LONG', async () => {
    const s = new DonchianBreakoutStrategy();
    // 通道 5 根：rising 的 high 分别 100+100*i+100 → max=599
    // ctx.candles 提供 6 根（第 6 根视为未收盘被排除），closed 前 5 根 max(high)=599
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      useVolSizing: false,
      baseQty: 0.01,
    });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        // closed = 前 5 根：high 分别 200/300/400/500/600 → max=600
        // 最后一根未收盘，第 6 根 high=700 → 用 markPrice=650 判上破（>600 且 <700）
        markPrice: 650,
        price: 650,
      }),
      executor,
    );
    expect(opens).toHaveLength(1);
    expect(opens[0].direction).toBe('LONG');
    expect(opens[0].quantity).toBeCloseTo(0.01, 8);
  });

  it('下破 min(low) → 开 SHORT', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      useVolSizing: false,
      baseQty: 0.01,
    });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        // closed 前 5 根 low 分别 0/100/200/300/400 → min=0（第一根 100-100=0）
        // markPrice < 0 才算下破——改造下降 K 线：直接构造 low 递增
        markPrice: -1,
        price: -1,
      }),
      executor,
    );
    // min=0 → markPrice=-1 → 下破 → SHORT
    expect(opens).toHaveLength(1);
    expect(opens[0].direction).toBe('SHORT');
  });

  it('通道内 → 不开仓', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      useVolSizing: false,
    });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeFlatCandles(6, 100_000, 50),
        // 通道 [99_950, 100_050]，markPrice=100_000 在中间
        markPrice: 100_000,
        price: 100_000,
      }),
      executor,
    );
    expect(opens).toHaveLength(0);
  });

  it('useVolSizing=true：qty 由 computeRiskScaledQty 决定（atr 翻倍 → qty 减半）', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      useVolSizing: true,
      riskPerTradePct: 0.5,
    });
    s.onStart?.(params);

    // 上涨 K 线，markPrice 上破
    const a = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 650,
        price: 650,
        atr: 200,
      }),
      a.executor,
    );
    const qtyA = a.opens[0]?.quantity ?? 0;

    const b = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 650,
        price: 650,
        atr: 400,
      }),
      b.executor,
    );
    const qtyB = b.opens[0]?.quantity ?? 0;

    expect(qtyA).toBeGreaterThan(0);
    expect(qtyB).toBeGreaterThan(0);
    expect(qtyB / qtyA).toBeCloseTo(0.5, 6);
  });
});

describe('DonchianBreakoutStrategy · 反向通道出场', () => {
  it('LONG 持仓中，markPrice 跌破 exitLookbackBars 下沿 → SIGNAL 平仓', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      chandelierK: 20, // 让吊灯远在射程外
      maxHoldBars: 10_000, // 关时间止损
      useVolSizing: false,
    });
    s.onStart?.(params);
    const { executor, closes } = makeExecutor();
    // closed = 前 5 根，最后 3 根 low 分别 200/300/400 → min=200
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 150,
        price: 150,
        atr: 10,
        openLots: [makeLot({ direction: 'LONG' })],
      }),
      executor,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe('SIGNAL');
  });

  it('反向通道优先于吊灯（同一 tick 都触发时以 SIGNAL 上报）', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      chandelierK: 1, // 吊灯距离小，几乎肯定同时触发
      maxHoldBars: 10_000,
      useVolSizing: false,
    });
    s.onStart?.(params);
    const { executor, closes } = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 150,
        price: 150,
        atr: 100,
        openLots: [makeLot({ direction: 'LONG' })],
      }),
      executor,
    );
    expect(closes[0].reason).toBe('SIGNAL');
  });
});

describe('DonchianBreakoutStrategy · 吊灯 + 时间止损', () => {
  it('吊灯 stop 单调不降（LONG）', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      chandelierK: 2,
      maxHoldBars: 10_000,
      useVolSizing: false,
      cooldownSec: 0,
    });
    s.onStart?.(params);

    // tick1：开仓（上破）—— markPrice=650，前 5 根 high max=600
    const e1 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 650,
        price: 650,
        atr: 10,
      }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);
    // 初始 stop = 650 - 2*10 = 630

    const lot = makeLot({ id: 'lot-1', direction: 'LONG', entryPrice: 650 });

    // tick2：markPrice 升到 700，候选 stop=700-20=680 → 更新为 680
    // 反向通道：closed 前 5 根 low 0/100/200/300/400 → min=0，未跌破
    const e2 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 700,
        price: 700,
        atr: 10,
        openLots: [lot],
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(0);

    // tick3：markPrice 回落到 675，候选 stop=675-20=655 < 680 → stop 保持 680 → 675<=680 → 触发
    const e3 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 675,
        price: 675,
        atr: 10,
        openLots: [lot],
      }),
      e3.executor,
    );
    expect(e3.closes).toHaveLength(1);
    expect(e3.closes[0].reason).toBe('STOP_LOSS');
  });

  it('时间止损：持仓时长 >= maxHoldBars * intervalMs 触发 SIGNAL', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      chandelierK: 20, // 让吊灯在射程外
      maxHoldBars: 3,
      useVolSizing: false,
    });
    s.onStart?.(params);
    const openedAt = 1_700_000_000_000;
    const lot = makeLot({ openedAt: new Date(openedAt).toISOString() });
    const { executor, closes } = makeExecutor();
    // intervalMs = 3_600_000（1h K 线）；now = openedAt + 3*3_600_000 → 命中
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeFlatCandles(6, 100_000, 50),
        markPrice: 100_000,
        price: 100_000,
        atr: 100,
        openLots: [lot],
        now: openedAt + 3 * 3_600_000,
      }),
      executor,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe('SIGNAL');
  });
});

describe('DonchianBreakoutStrategy · 冷却', () => {
  it('平仓后 cooldownSec 内即使满足突破条件也不开新仓', async () => {
    const s = new DonchianBreakoutStrategy();
    const params = s.normalizeParams({
      breakoutLookbackBars: 5,
      exitLookbackBars: 3,
      chandelierK: 1,
      maxHoldBars: 10_000,
      useVolSizing: false,
      cooldownSec: 3600,
    });
    s.onStart?.(params);

    // tick1：开仓
    const e1 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 650,
        price: 650,
        atr: 10,
      }),
      e1.executor,
    );
    expect(e1.opens).toHaveLength(1);

    // tick2：平仓（吊灯触发）
    const lot = makeLot({ id: 'lot-1', direction: 'LONG', entryPrice: 650 });
    const e2 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 500, // 触发吊灯：stop 初值 630，markPrice<=630 → 平
        price: 500,
        atr: 10,
        openLots: [lot],
      }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(1);

    // tick3：冷却中即使突破条件重新成立（markPrice=700）也不开
    const e3 = makeExecutor();
    await s.onTick(
      makeContext(s, {
        params,
        candles: makeRisingCandles(6, 100, 100),
        markPrice: 700,
        price: 700,
        atr: 10,
        // now 距上次平仓 60s < cooldownSec=3600s
        now: 1_700_000_000_000 + 30 * 3_600_000 + 60_000,
      }),
      e3.executor,
    );
    expect(e3.opens).toHaveLength(0);
  });
});
