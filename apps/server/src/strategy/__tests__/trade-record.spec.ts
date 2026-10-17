import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBusService } from '../../common/events';
import { TradeRecordService, slugOf } from '../trade-record.service';
import { MartingaleGridV2Strategy } from '../martingale-grid-v2.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

/**
 * 交易档案事件流（2026-10-17 实测调优回路）。
 * - TradeRecordService：JSONL 落盘、按 slug 分目录、日切文件名、写失败不抛；
 * - V2 EXIT_TRACE：经 ctx.trace 写出的字段完整性（差分解四段可算）。
 */
let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

const flush = (svc: TradeRecordService) => (svc as unknown as { queue: Promise<void> }).queue;

async function makeService(): Promise<TradeRecordService> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'records-'));
  process.env.TRADE_RECORD_DIR = dir;
  // 重置 dirReady（每个用例换新临时目录）
  const svc = new TradeRecordService(new EventBusService());
  return svc;
}

async function readEvents(slug: string): Promise<Record<string, unknown>[]> {
  const base = path.join(dir, slug);
  const files = await fs.readdir(base);
  const day = files.find((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  expect(day).toBeTruthy();
  const text = await fs.readFile(path.join(base, day as string), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('slugOf', () => {
  it('冒号转横杠、非法字符转下划线、平台级走 _platform', () => {
    expect(slugOf('martingale_grid_v2:BTCUSDT')).toBe('martingale_grid_v2-BTCUSDT');
    expect(slugOf('-')).toBe('_platform');
    expect(slugOf('a b/c:x')).toBe('a_b_c-x');
  });
});

describe('TradeRecordService', () => {
  it('event() 落一行 JSONL，含 ts/time/inst/type + payload', async () => {
    const svc = await makeService();
    svc.event('martingale_grid_v2:BTCUSDT', 'EXIT_TRACE', { net: 26, layers: 1 });
    await flush(svc);
    const rows = await readEvents('martingale_grid_v2-BTCUSDT');
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('EXIT_TRACE');
    expect(rows[0].inst).toBe('martingale_grid_v2:BTCUSDT');
    expect(rows[0].net).toBe(26);
    expect(typeof rows[0].ts).toBe('number');
    expect(typeof rows[0].time).toBe('string');
  });

  it('lotOpened/lotClosed 进程事件自动映射为 LOT_OPEN/LOT_SETTLE', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'records-'));
    process.env.TRADE_RECORD_DIR = dir;
    const events = new EventBusService();
    const svc = new TradeRecordService(events);
    svc.onModuleInit();
    events.emit('lotOpened', {
      symbol: 'BTCUSDT',
      market: 'futures',
      direction: 'LONG',
      quantity: 0.1,
      entryPrice: 63000,
      fee: 2.5,
      strategyInstanceId: 'martingale_grid_v2:BTCUSDT',
      source: 'strategy',
      mode: 'testnet',
      ts: Date.now(),
    });
    await flush(svc);
    const rows = await readEvents('martingale_grid_v2-BTCUSDT');
    expect(rows[0].type).toBe('LOT_OPEN');
    expect(rows[0].entryPrice).toBe(63000);
    expect(rows[0].fee).toBe(2.5);
  });

  it('平台级 FAILED 订单进 _platform 目录', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'records-'));
    process.env.TRADE_RECORD_DIR = dir;
    const events = new EventBusService();
    const svc = new TradeRecordService(events);
    svc.onModuleInit();
    events.emit('order', {
      id: 'ord-1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.1,
      status: 'FAILED',
      error: '订单已存在',
      source: 'STRATEGY',
      mode: 'testnet',
    } as never);
    await flush(svc);
    const rows = await readEvents('_platform');
    expect(rows[0].type).toBe('ORDER_FAIL');
    expect(rows[0].orderId).toBe('ord-1');
  });
});

describe('MartingaleGridV2Strategy · EXIT_TRACE 字段完整性', () => {
  function lot(o: Partial<StrategyLotView> = {}): StrategyLotView {
    return {
      id: 'lot-1',
      direction: 'LONG',
      quantity: 0.1,
      entryPrice: 100_000,
      unrealizedPnl: 30,
      entryFeeUsdt: 4,
      openedAt: new Date().toISOString(),
      hasPendingClose: false,
      ...o,
    };
  }

  it('无规则命中时写出含四段差分解字段的 EXIT_TRACE', async () => {
    const v2 = new MartingaleGridV2Strategy();
    const params = v2.normalizeParams({
      basketTakeProfitUsdt: 60,
      basketStopLossUsdt: 60,
      baseQty: 0.1,
    });
    const captured: Record<string, unknown>[] = [];
    const ctx = {
      symbol: 'BTCUSDT',
      instanceId: 'martingale_grid_v2:BTCUSDT',
      price: 100_300,
      markPrice: 100_300,
      atr: 100,
      candles: [],
      openLots: [lot()],
      openOrders: [],
      availableMargin: 5000,
      walletBalance: 5000,
      netQty: 0.1,
      params,
      now: 1_700_000_000_000,
      trace: (evt) => captured.push(evt as unknown as Record<string, unknown>),
    } as unknown as StrategyContext;
    const exec = {
      async openLot() {
        return { lotId: 'x' };
      },
      async closeLot() {
        return { ok: true };
      },
      async placeStopOrder() {
        return { orderId: 'o' };
      },
      async cancelOrder() {
        return { ok: true };
      },
    } as unknown as StrategyExecutor;

    await v2.onTick(ctx, exec);

    const exitTrace = captured.find((c) => c.type === 'EXIT_TRACE');
    expect(exitTrace).toBeTruthy();
    // 核心差分字段
    for (const k of ['net', 'netAtLast', 'gross', 'exitFeeEst', 'netPct', 'rules', 'notExit', 'last', 'mark']) {
      expect(exitTrace).toHaveProperty(k);
    }
    const rules = exitTrace?.rules as Record<string, Record<string, number>>;
    expect(rules.tpUsdt.thr).toBe(60);
    expect(typeof rules.tpUsdt.gap).toBe('number');
    expect(rules.trail).toHaveProperty('gapToArmPct');
    expect(rules.trail).toHaveProperty('gapToGivebackPct');
  });
});
