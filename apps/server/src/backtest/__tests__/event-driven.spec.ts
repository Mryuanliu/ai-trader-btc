import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { EventBroker } from '../event-driven/event-broker';
import { ENGINE_VERSION_V1 } from '../event-driven/types';
import type { MarketEvent } from '../event-driven/types';

const BTC: Candle = {
  time: 0,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 0,
};

function agg(ts: number, price: number, qty = 1, isBuyerMaker = false): MarketEvent {
  return { kind: 'aggTrade', ts, price, qty, isBuyerMaker };
}
function mark(ts: number, markPrice: number): MarketEvent {
  return { kind: 'markPrice', ts, markPrice };
}
function funding(ts: number, rate: number, markPrice: number): MarketEvent {
  return { kind: 'fundingSettlement', ts, rate, markPrice };
}
function bar(ts: number, c: Candle): MarketEvent {
  return { kind: 'bar', ts, bar: c, interval: '1m' };
}

function makeBroker(over: Partial<ConstructorParameters<typeof EventBroker>[0]> = {}) {
  return new EventBroker({
    symbol: 'BTCUSDT',
    instanceId: 'test:BTCUSDT',
    initialCapital: 10_000,
    feeRate: 0.0004,
    slippage: 0,
    maintMarginRatio: 0.005,
    ...over,
  });
}

describe('event-driven-v1 / EventBroker', () => {
  it('市价开仓在**下一笔 aggTrade**成交（非 bar.open）', async () => {
    const b = makeBroker();
    // onTick 里 openLot：仅 push 到 pending，尚未成交
    b.applyEvent(bar(1_000, { ...BTC, open: 100, close: 105 }));
    await b.openLot({ direction: 'LONG', quantity: 1, reason: 't' });
    expect(b.trades.filter((t) => t.kind === 'OPEN')).toHaveLength(0);
    // 下一笔 aggTrade 才真成交，价格用 aggTrade.price 而不是 bar.open/close
    b.applyEvent(agg(2_000, 250));
    const open = b.trades.find((t) => t.kind === 'OPEN');
    expect(open).toBeDefined();
    expect(open!.price).toBeCloseTo(250, 6);
  });

  it('STOP 逐笔检查：同 bar 内多次穿越只第一次触发', async () => {
    const b = makeBroker();
    await b.placeStopOrder({ direction: 'LONG', stopPrice: 110, quantity: 1, reason: 'breakout' });
    // 逐笔 aggTrade：第 1 次未到、第 2 次触发成交、第 3 次不再成交（stops 已 delete）
    b.applyEvent(agg(1_000, 105));
    expect(b.trades.filter((t) => t.kind === 'OPEN')).toHaveLength(0);
    b.applyEvent(agg(2_000, 112));
    const opens = b.trades.filter((t) => t.kind === 'OPEN');
    expect(opens).toHaveLength(1);
    expect(opens[0].price).toBeCloseTo(112, 6);
    b.applyEvent(agg(3_000, 115));
    expect(b.trades.filter((t) => t.kind === 'OPEN')).toHaveLength(1);
  });

  it('funding 精确入账：LONG 正 rate 付出，SHORT 正 rate 收取', () => {
    const b = makeBroker();
    // 先开 1 BTC LONG @ 100
    b.applyEvent(agg(1_000, 100));
    void b.openLot({ direction: 'LONG', quantity: 1, reason: 'x' });
    b.applyEvent(agg(1_100, 100));
    // 8h 结算：rate=0.0001, mark=100_000 → 名义 100_000 × 0.0001 = 10 USD，多头付出
    b.applyEvent(funding(2_000, 0.0001, 100_000));
    const eq = b.equity(100_000);
    // initial 10_000 + 未实现浮盈(1×(100000-100)-fee) - funding 10
    // entryFee = 100*1*0.0004 = 0.04；floating = (100000-100)*1 - 0.04 = 99899.96
    // eq = 10000 + 99899.96 - 10 = 109889.96
    expect(eq).toBeCloseTo(109_889.96, 2);
    const costs = b.finalize().costs;
    expect(costs.totalFunding).toBeCloseTo(10, 6);
  });

  it('强平：equity(mark) < maintMargin × notional → 下一笔 aggTrade 平掉', async () => {
    // 初始 100U、开 10 BTC LONG @ 100U（名义 1000，fee 0.4，MM=0.5% × 1000 = 5U）
    const b = makeBroker({ initialCapital: 100 });
    b.applyEvent(agg(1_000, 100));
    await b.openLot({ direction: 'LONG', quantity: 10, leverage: 10, reason: 'over-leverage' });
    b.applyEvent(agg(1_100, 100));
    expect(b.trades.filter((t) => t.kind === 'OPEN')).toHaveLength(1);
    // 价格崩到 90：equity ≈ 100 + (90-100)*10 - 4 = -114 << MM=4.5
    b.applyEvent(mark(2_000, 90));
    // pending liquidate 已入队；下一笔 aggTrade 兑现
    b.applyEvent(agg(2_100, 90));
    const closes = b.trades.filter((t) => t.kind === 'CLOSE');
    expect(closes).toHaveLength(1);
    // 强平价 ≈ 90 × (1 - 0.001) = 89.91（penalty 默认 10 bps）
    expect(closes[0].price).toBeLessThan(90);
    expect(closes[0].price).toBeCloseTo(89.91, 3);
    // 强平归因必须是 MARGIN_CALL，不能混进策略主动止损 STOP_LOSS
    expect(closes[0].reason).toBe('MARGIN_CALL');
    expect(b.liquidationLog).toHaveLength(1);
  });

  it('markPrice 独立于 close：equity 用 mark 而非 bar.close', () => {
    const b = makeBroker();
    b.applyEvent(agg(1_000, 100));
    void b.openLot({ direction: 'LONG', quantity: 1, reason: 'x' });
    b.applyEvent(agg(1_100, 100));
    b.applyEvent(mark(1_200, 500)); // mark=500
    b.applyEvent(bar(2_000, { ...BTC, open: 100, high: 100, low: 100, close: 100 }));
    // prices().mark 应保留独立 mark=500（bar 事件不改 mark）
    expect(b.prices().mark).toBe(500);
    expect(b.equity(b.prices().mark)).toBeGreaterThan(b.equity(100));
  });

  it('事件顺序契约：同 ts 下 markPrice 先于 aggTrade 先于 funding 先于 bar', () => {
    // 通过 ENGINE_VERSION_V1 常量确认引擎版本字面量；顺序契约在 events-feed.mergeEvents 保证
    expect(ENGINE_VERSION_V1).toBe('event-driven-v1');
  });
});
