import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { SimBroker } from '../sim-broker';

const mk = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
  volume: 1,
});

function broker(slippage = 0.001, feeRate = 0.0004): SimBroker {
  return new SimBroker({
    symbol: 'BTCUSDT',
    instanceId: 'test:BTCUSDT',
    initialCapital: 10_000,
    feeRate,
    slippage,
    fundingPctPer8h: 0,
    intervalMs: 300_000,
  });
}

describe('SimBroker 撮合约定', () => {
  it('市价单在下一根 bar 开盘成交，滑点不利、双边计费，产出一条已了结轮次', async () => {
    const b = broker();
    const { lotId } = await b.openLot({ direction: 'LONG', quantity: 1, leverage: 1, reason: 'x' });
    expect(lotId).toBeTruthy();
    // 受理但未成交：此刻不应出现在持仓里
    expect(b.lotViews(110)).toHaveLength(0);

    // 下一根开盘 110 → 多头买入抬滑点：entry = 110 * 1.001 = 110.11
    b.beginBar(mk(0, 110, 112, 109, 111));
    const v = b.lotViews(120);
    expect(v).toHaveLength(1);
    expect(v[0].entryPrice).toBeCloseTo(110.11, 6);
    // 浮盈按判定价 120：(120-110.11)*1 - 开仓费(110.11*0.0004=0.044044) = 9.845956
    expect(v[0].unrealizedPnl).toBeCloseTo(9.845956, 4);

    await b.closeLot(v[0].id, 'TAKE_PROFIT');
    // 平仓在下一根开盘 130 成交：多头卖出压滑点 exit = 130 * 0.999 = 129.87
    b.beginBar(mk(300_000, 130, 131, 129, 130));
    const { rounds } = b.finalize();
    expect(rounds).toHaveLength(1);
    expect(rounds[0].layerCount).toBe(1);
    // 已实现 = (129.87-110.11) - 开仓费0.044044 - 平仓费(129.87*0.0004=0.051948) ≈ 19.664008
    expect(rounds[0].realizedPnl).toBeCloseTo(19.664008, 4);
  });

  it('STOP 用当根 high/low 触发并处理跳空（BUY 取 max(stop, open)）', async () => {
    const b = broker();
    const { orderId } = await b.placeStopOrder({ direction: 'LONG', stopPrice: 100, quantity: 1, leverage: 1, reason: 'grid' });
    expect(orderId).toBeTruthy();
    expect(b.orderViews()).toHaveLength(1);

    // 开盘 105 已高于 stop 100 → 跳空，成交价取更高的开盘价，而非 stop
    b.beginBar(mk(0, 105, 110, 104, 108));
    const v = b.lotViews(108);
    expect(v).toHaveLength(1);
    expect(v[0].entryPrice).toBeCloseTo(105 * 1.001, 4);
    // 触发后挂单被消耗
    expect(b.orderViews()).toHaveLength(0);
  });

  it('未触及触发价的 STOP 保持挂起', async () => {
    const b = broker();
    await b.placeStopOrder({ direction: 'LONG', stopPrice: 200, quantity: 1, leverage: 1, reason: 'grid' });
    b.beginBar(mk(0, 105, 150, 104, 140)); // high 150 < 200 不触发
    expect(b.lotViews(140)).toHaveLength(0);
    expect(b.orderViews()).toHaveLength(1);
  });

  it('同一建仓周期的多笔归为一个篮子（layerCount 累计，全平才结一轮）', async () => {
    const b = broker();
    await b.openLot({ direction: 'LONG', quantity: 1, leverage: 1, reason: 'L1' });
    await b.openLot({ direction: 'LONG', quantity: 1, leverage: 1, reason: 'L2' });
    b.beginBar(mk(0, 110, 112, 109, 111));
    const v = b.lotViews(111);
    expect(v).toHaveLength(2);
    expect(b.netQty()).toBeCloseTo(2, 8);

    await b.closeLot(v[0].id, 'MANUAL');
    await b.closeLot(v[1].id, 'MANUAL');
    b.beginBar(mk(300_000, 115, 116, 114, 115));
    const { rounds } = b.finalize();
    expect(rounds).toHaveLength(1);
    expect(rounds[0].layerCount).toBe(2);
  });
});
