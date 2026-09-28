import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { EventBusService, LotClosedEvent, LotOpenedEvent, BasketClosedEvent } from '../common/events';
import type { FeishuService } from './feishu.service';
import { FeishuNotificationService } from './feishu-notification.service';

function build(opts: { enabled?: boolean; configured?: boolean; chatId?: string }) {
  const events = new EventBusService();
  const sendCard = vi.fn().mockResolvedValue(undefined);
  const feishu = {
    isConfigured: () => opts.configured ?? true,
    sendCard,
  } as unknown as FeishuService;
  const store: Record<string, unknown> = {
    FEISHU_PUSH_ENABLED: opts.enabled ?? true,
    FEISHU_CHAT_ID: opts.chatId ?? 'oc_test_chat',
  };
  const config = { get: (k: string) => store[k] } as unknown as ConfigService;
  const svc = new FeishuNotificationService(events, feishu, config);
  return { events, sendCard, svc };
}

const open: LotOpenedEvent = {
  symbol: 'BTCUSDT',
  market: 'futures',
  direction: 'SHORT',
  quantity: 0.1,
  entryPrice: 82985,
  fee: 3.3194,
  strategyInstanceId: 'martingale_grid:BTCUSDT',
  source: 'strategy',
  mode: 'testnet',
  ts: Date.UTC(2026, 8, 29, 15, 7),
};

const close: LotClosedEvent = {
  symbol: 'BTCUSDT',
  market: 'futures',
  direction: 'SHORT',
  quantity: 0.1,
  entryPrice: 82985,
  exitPrice: 82960,
  realizedPnl: 2.1,
  returnPct: 0.0002,
  exitReason: 'TAKE_PROFIT',
  strategyInstanceId: 'martingale_grid:BTCUSDT',
  basketCode: 'BK-20260929-009',
  mode: 'testnet',
  ts: Date.now(),
};

const basket: BasketClosedEvent = {
  code: 'BK-20260929-009',
  symbol: 'BTCUSDT',
  direction: 'SHORT',
  layerCount: 3,
  realizedPnl: 15.2,
  returnPct: 0.004,
  feeTotal: 6.64,
  fundingFee: 0,
  mode: 'testnet',
  ts: Date.now(),
};

describe('FeishuNotificationService', () => {
  it('formats open/close/basket cards with expected fields', () => {
    const { svc } = build({});
    const openText = svc.formatOpen(open);
    expect(openText).toContain('【开仓成交】BTCUSDT 空 0.1 @ 82985.00');
    expect(openText).toContain('手续费 3.32 USDT');
    expect(openText).toContain('martingale_grid:BTCUSDT');

    const closeText = svc.formatClose(close);
    expect(closeText).toContain('【平仓结束】BTCUSDT 空 0.1');
    expect(closeText).toContain('82985.00 → 82960.00');
    expect(closeText).toContain('净盈亏 +2.10 USDT');

    const basketText = svc.formatBasket(basket);
    expect(basketText).toContain('【整轮了结】BK-20260929-009');
    expect(basketText).toContain('层数 3');
    expect(basketText).toContain('整体净盈亏 +15.20 USDT');
  });

  it('pushes real-mode fills to the configured chat', () => {
    const { events, sendCard, svc } = build({});
    svc.onModuleInit();
    events.emit('lotOpened', open);
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith('oc_test_chat', expect.stringContaining('【开仓成交】'));
  });

  it('filters out dry_run events', () => {
    const { events, sendCard, svc } = build({});
    svc.onModuleInit();
    events.emit('lotOpened', { ...open, mode: 'dry_run' });
    events.emit('lotClosed', { ...close, mode: 'dry_run' });
    events.emit('basketClosed', { ...basket, mode: 'dry_run' });
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('is a no-op when chat id is missing', () => {
    const { events, sendCard, svc } = build({ chatId: '' });
    svc.onModuleInit();
    events.emit('lotOpened', open);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('is a no-op when the feishu client is not configured', () => {
    const { events, sendCard, svc } = build({ configured: false });
    svc.onModuleInit();
    events.emit('lotClosed', close);
    expect(sendCard).not.toHaveBeenCalled();
  });
});
