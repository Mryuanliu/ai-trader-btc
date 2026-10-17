import { describe, expect, it, vi } from 'vitest';
import { StrategyExecutorService } from '../strategy-executor.service';

/**
 * 2026-10-16 复盘：placeOrder 内部 catch 掉交易所异常只把订单标 FAILED、不抛出，
 * 导致 executor 永远拿到 ok:true——策略以为「已全平」，实际 Lot 仍 OPEN，
 * 每 tick 盲发废单（同一幽灵仓 17.5h 发了 665 张 -2022）。
 * 这里锁定 executor 必须把 FAILED 订单如实上报为失败。
 */
function harness() {
  const placeOrder = vi.fn();
  const trading: any = { placeOrder };
  const lots: any = {
    getOpenLot: vi.fn((id: string) =>
      Promise.resolve({ id, direction: 'LONG', strategyInstanceId: 'x:BTCUSDT' }),
    ),
    findByOpenOrderId: vi.fn(() => Promise.resolve(null)),
  };
  return { svc: new StrategyExecutorService(trading, lots), placeOrder, lots };
}

describe('StrategyExecutor 失败平仓/开仓必须如实上报', () => {
  it('closeLot：订单标 FAILED → ok:false，不再谎报成功', async () => {
    const { svc, placeOrder } = harness();
    placeOrder.mockResolvedValue({
      order: { id: 'o1', status: 'FAILED', error: 'HTTP 400 {"code":-2022}' },
    });
    const r = await svc.closeLot('lot-1', 'STOP_LOSS');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('-2022');
  });

  it('closeLot：订单 NEW（在途）→ ok:true', async () => {
    const { svc, placeOrder } = harness();
    placeOrder.mockResolvedValue({ order: { id: 'o1', status: 'NEW', error: null } });
    const r = await svc.closeLot('lot-1', 'STOP_LOSS');
    expect(r.ok).toBe(true);
  });

  it('closeLot：订单 FILLED（当场成交）→ ok:true', async () => {
    const { svc, placeOrder } = harness();
    placeOrder.mockResolvedValue({ order: { id: 'o1', status: 'FILLED', error: null } });
    const r = await svc.closeLot('lot-1', 'TAKE_PROFIT');
    expect(r.ok).toBe(true);
  });

  it('openLot：订单标 FAILED → lotId=null 且带 error', async () => {
    const { svc, placeOrder } = harness();
    placeOrder.mockResolvedValue({
      order: { id: 'o1', status: 'FAILED', error: 'HTTP 400 {"code":-2019}' },
    });
    const r = await svc.openLot({ direction: 'LONG', quantity: 0.1, leverage: 10, reason: 'x' });
    expect(r.lotId).toBeNull();
    expect(r.error).toContain('-2019');
  });

  it('closeLot：未找到 OPEN Lot → ok:false（不触发下单）', async () => {
    const { svc, placeOrder, lots } = harness();
    lots.getOpenLot.mockResolvedValue(null);
    const r = await svc.closeLot('gone', 'STOP_LOSS');
    expect(r.ok).toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
