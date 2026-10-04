import { describe, it, expect } from 'vitest';
import { StrategyRunner } from '../strategy-runner.service';
import { EventBusService } from '../../common/events';
import type { Candle } from '@ai-trader/shared';

/**
 * 验证 runner 的核心修正：按**实例运行周期**喂 K 线（否则 1h 调出来的冠军参
 * 喂 1m 会退化成 80 分钟通道 = 已证实的 -99% 老路），并按入场通道根数放大上下文。
 */
const mkCandles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3_600_000,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));

function buildRunner(calls: { interval: string; limit: number }[]) {
  const noop = () => undefined;
  const market = {
    getTicker: () => ({ price: 100, lastPrice: 100, changePercent24h: 0 }),
    getCandles: (_s: string, interval: string, limit: number) => {
      calls.push({ interval, limit });
      return mkCandles(300);
    },
  };
  const lots = { listOpen: async () => [], toDTO: (l: unknown) => l };
  const trading = {
    listOpenOrders: async () => [],
    listPendingCloseLotIds: async () => [],
    getAvailableMargin: async () => 0,
  };
  const positions = { listPositions: async () => [] };
  const journal = { lifecycle: noop, decision: noop, forgetInstance: noop };
  const runner = new StrategyRunner(
    noop as never, // registry
    noop as never, // executor
    market as never, // market
    noop as never, // futuresConfig
    trading as never, // trading
    positions as never, // positions
    lots as never, // lots
    noop as never, // baskets
    { markStopped: noop } as never, // instanceService
    noop as never, // protection
    new EventBusService(), // events
    journal as never, // journal
  );
  return runner;
}

type BuildCtx = (inst: unknown) => Promise<unknown>;

describe('StrategyRunner · buildContextFor 按实例周期喂线', () => {
  it('interval 透传为该周期；limit 取 max(基础上限, brk+5)', async () => {
    const calls: { interval: string; limit: number }[] = [];
    const runner = buildRunner(calls);
    const buildContextFor = (runner as unknown as { buildContextFor: BuildCtx }).buildContextFor;
    const ctx = await buildContextFor.call(runner, {
      instanceId: 'donchian_breakout:BTCUSDT',
      symbol: 'BTCUSDT',
      params: { breakoutLookbackBars: 80 },
      interval: '1h',
    });
    expect(ctx).not.toBeNull();
    // max(150, 80+5=85) = 150
    expect(calls[0]).toEqual({ interval: '1h', limit: 150 });
  });

  it('brk 超过基础上限时放大 limit，且不再固定 1m', async () => {
    const calls: { interval: string; limit: number }[] = [];
    const runner = buildRunner(calls);
    const buildContextFor = (runner as unknown as { buildContextFor: BuildCtx }).buildContextFor;
    await buildContextFor.call(runner, {
      instanceId: 'donchian_breakout:BTCUSDT',
      symbol: 'BTCUSDT',
      params: { breakoutLookbackBars: 200 },
      interval: '4h',
    });
    expect(calls[0].interval).toBe('4h');
    expect(calls[0].limit).toBe(205); // max(150, 200+5)
  });
});
