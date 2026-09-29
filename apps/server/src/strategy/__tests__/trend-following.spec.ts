import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { TrendFollowingStrategy } from '../trend-following.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

/**
 * 趋势策略 P1 三件套覆盖：
 * - L1 波动率定标：qty 随 atr 反比缩放；useVolSizing=false 走 baseQty
 * - L2 regime 门控：|fast-slow|/ATR 不达 → 不开新仓；已有持仓照旧管理
 * - L3 吊灯 + 时间止损：stop 单调；持仓超 maxHoldBars 触发平仓
 */

/** 造一段单调上涨的 K 线（EMA9/21 会持续给出多头信号） */
function makeTrendCandles(n: number, startPrice = 100_000, slopePerBar = 200): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const price = startPrice + i * slopePerBar;
    return {
      time: 1_700_000_000_000 + i * 300_000,
      open: price,
      high: price + slopePerBar,
      low: price - slopePerBar,
      close: price + slopePerBar / 2,
      volume: 1,
    };
  });
}

/** 横盘 K 线（spread 相对 atr 会很小，触发 regime 门控） */
function makeFlatCandles(n: number, price = 100_000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000_000 + i * 300_000,
    open: price,
    high: price + 50,
    low: price - 50,
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
      opens.push({ direction: input.direction, quantity: input.quantity, leverage: input.leverage ?? 1 });
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
  strategy: TrendFollowingStrategy,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    instanceId: 'trend_following:BTCUSDT',
    price: 100_000,
    markPrice: 100_000,
    atr: 200,
    candles: makeTrendCandles(60),
    openLots: [],
    openOrders: [],
    availableMargin: 10_000,
    netQty: 0,
    params: strategy.normalizeParams(),
    now: 1_700_000_000_000 + 60 * 300_000,
    ...overrides,
  };
}

describe('TrendFollowingStrategy · L1 波动率定标', () => {
  it('useVolSizing=true：qty 与 atr 反比（同 equity/risk% 下 atr 翻倍 → qty 减半）', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({ useVolSizing: true, riskPerTradePct: 0.5, regimeMin: 0 });
    s.onStart?.(params);

    const a = makeExecutor();
    await s.onTick(makeContext(s, { params, atr: 200 }), a.executor);
    const qtyA = a.opens[0]?.quantity ?? 0;

    const b = makeExecutor();
    await s.onTick(makeContext(s, { params, atr: 400 }), b.executor);
    const qtyB = b.opens[0]?.quantity ?? 0;

    expect(qtyA).toBeGreaterThan(0);
    expect(qtyB).toBeGreaterThan(0);
    // atr 翻倍 → qty 减半
    expect(qtyB / qtyA).toBeCloseTo(0.5, 6);
  });

  it('useVolSizing=false：走 baseQty', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({ useVolSizing: false, baseQty: 0.02, regimeMin: 0 });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(makeContext(s, { params }), executor);
    expect(opens[0]?.quantity).toBeCloseTo(0.02, 8);
  });
});

describe('TrendFollowingStrategy · L2 regime 门控', () => {
  it('横盘 K 线（spread/atr < regimeMin）→ 不开仓', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({ regimeMin: 0.5, useVolSizing: false });
    s.onStart?.(params);
    const { executor, opens } = makeExecutor();
    await s.onTick(
      makeContext(s, { params, candles: makeFlatCandles(60), atr: 100 }),
      executor,
    );
    expect(opens).toHaveLength(0);
  });

  it('持仓中即使 regime 不达也不影响出场判定（regime 只作用于开仓）', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({ regimeMin: 5, chandelierK: 3, maxHoldBars: 1 });
    s.onStart?.(params);
    const { executor, closes } = makeExecutor();
    // 持仓 + 时间到 → 平
    const openedAt = 1_700_000_000_000;
    await s.onTick(
      makeContext(
        s,
        {
          params,
          openLots: [makeLot({ openedAt: new Date(openedAt).toISOString() })],
          now: openedAt + 10 * 300_000,
        },
      ),
      executor,
    );
    expect(closes.some((c) => c.reason === 'SIGNAL')).toBe(true);
  });
});

describe('TrendFollowingStrategy · L3 吊灯 + 时间止损', () => {
  it('吊灯 stop 单调不降：先小幅回撤后继续上行，stop 保持此前高位', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({
      regimeMin: 0,
      useVolSizing: false,
      chandelierK: 2,
      takeProfitPct: 1, // 关闭固定 TP，避免干扰
      stopLossPct: 1, // 关闭固定 SL
      maxHoldBars: 10_000, // 关闭时间止损
      cooldownSec: 0,
    });
    s.onStart?.(params);

    // 首 tick：开仓
    const e1 = makeExecutor();
    await s.onTick(makeContext(s, { params, markPrice: 100_000, atr: 100 }), e1.executor);
    expect(e1.opens).toHaveLength(1);

    // 第二 tick：markPrice 升到 105_000，ATR 100 → stop 应升到 105_000 - 200 = 104_800
    const lot = makeLot({ id: 'lot-1', entryPrice: 100_000, direction: 'LONG', unrealizedPnl: 5000 * 0.5 });
    const e2 = makeExecutor();
    await s.onTick(
      makeContext(s, { params, markPrice: 105_000, atr: 100, openLots: [lot] }),
      e2.executor,
    );
    expect(e2.closes).toHaveLength(0);

    // 第三 tick：markPrice 回落到 104_000，ATR 100 → 候选 stop=104_000-200=103_800，
    // 但既有 stop 已升到 104_800 → 触发吊灯平仓
    const e3 = makeExecutor();
    await s.onTick(
      makeContext(s, { params, markPrice: 104_000, atr: 100, openLots: [lot] }),
      e3.executor,
    );
    expect(e3.closes).toHaveLength(1);
    expect(e3.closes[0].reason).toBe('STOP_LOSS');
  });

  it('时间止损：持仓时长 >= maxHoldBars * intervalMs 触发 SIGNAL 平仓', async () => {
    const s = new TrendFollowingStrategy();
    const params = s.normalizeParams({
      regimeMin: 0,
      useVolSizing: false,
      chandelierK: 10, // 让吊灯远在射程外
      takeProfitPct: 1,
      stopLossPct: 1,
      maxHoldBars: 3,
    });
    s.onStart?.(params);
    const openedAt = 1_700_000_000_000;
    const lot = makeLot({ openedAt: new Date(openedAt).toISOString() });
    const { executor, closes } = makeExecutor();
    // 现在 = 起始 + 3 根 5m = 900_000ms ≥ maxHoldBars * intervalMs
    await s.onTick(
      makeContext(
        s,
        { params, openLots: [lot], markPrice: 100_000, atr: 100, now: openedAt + 900_000 },
      ),
      executor,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe('SIGNAL');
  });
});
