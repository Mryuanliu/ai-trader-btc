import { describe, expect, it, vi } from 'vitest';
import type { ProtectionsConfig } from '@ai-trader/shared';
import { ProtectionService } from '../protection.service';
import { StrategyRunner } from '../strategy-runner.service';
import { EventBusService, type BasketClosedEvent } from '../../common/events';
import type { BasketEntity } from '../../database/entities/basket.entity';
import type { FuturesConfigService } from '../../futures/futures-config.service';

const INSTANCE = 'mean_reversion:BTCUSDT';

/** 造一条 CLOSED 篮子：net = realizedPnl + fundingFee，按调用顺序即 closedAt 升序 */
function basket(net: number, inst = INSTANCE): BasketEntity {
  return {
    status: 'CLOSED',
    strategyInstanceId: inst,
    realizedPnl: String(net),
    fundingFee: '0',
    closedAt: new Date(2026, 9, 1),
  } as unknown as BasketEntity;
}

/** 造一条「微亏但资金费为正」的篮子（net = realizedPnl + fundingFee 分开控制） */
function basketSplit(realized: number, funding: number, inst = INSTANCE): BasketEntity {
  return {
    status: 'CLOSED',
    strategyInstanceId: inst,
    realizedPnl: String(realized),
    fundingFee: String(funding),
    closedAt: new Date(2026, 9, 1),
  } as unknown as BasketEntity;
}

function build(rows: BasketEntity[], over: Partial<ProtectionsConfig> = {}) {
  const cfg: ProtectionsConfig = {
    enabled: true,
    maxConsecutiveLosses: 8,
    maxDrawdownPct: 15,
    capitalBaseUsdt: 10_000,
    lookbackBaskets: 0,
    ...over,
  };
  const find = vi.fn(async (opts: { where: { status: string; strategyInstanceId: string } }) =>
    rows.filter(
      (r) => r.status === 'CLOSED' && r.strategyInstanceId === opts.where.strategyInstanceId,
    ),
  );
  const repo = { find } as unknown as ConstructorParameters<typeof ProtectionService>[0];
  const futuresConfig = {
    get: async () => ({ protections: cfg }),
  } as unknown as FuturesConfigService;
  const svc = new ProtectionService(repo, futuresConfig);
  return { svc, find };
}

describe('ProtectionService.evaluate', () => {
  it('1. 未启用直接短路，不查库也不判', async () => {
    const { svc, find } = build([basket(-1), basket(-1)], { enabled: false });
    const v = await svc.evaluate(INSTANCE);
    expect(v.halt).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('2. 尾部连续 8 笔净亏达阈 → halt，reason 含「连亏」', async () => {
    const rows = Array.from({ length: 8 }, () => basket(-5));
    const { svc } = build(rows, { maxConsecutiveLosses: 8 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.consecutiveLosses).toBe(8);
    expect(v.halt).toBe(true);
    expect(v.reason).toContain('连亏');
  });

  it('3. 连亏 7 笔（差 1 未达阈）→ 不 halt', async () => {
    const rows = Array.from({ length: 7 }, () => basket(-5));
    const { svc } = build(rows, { maxConsecutiveLosses: 8 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.consecutiveLosses).toBe(7);
    expect(v.halt).toBe(false);
  });

  it('4. 中间盈利打断连续 → 只数尾部连续段', async () => {
    // 亏 亏 盈 亏 亏：尾部连续仅 2
    const rows = [basket(-5), basket(-5), basket(3), basket(-5), basket(-5)];
    const { svc } = build(rows, { maxConsecutiveLosses: 8 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.consecutiveLosses).toBe(2);
    expect(v.halt).toBe(false);
  });

  it('5. 资金费把微亏拉成正 → 该篮算盈利，连续段被重置', async () => {
    // 尾部：realized -1 + funding +2 = net +1（盈），其后两亏；连续应为 2 而非 3
    const rows = [
      basketSplit(-1, 2), // net +1 盈
      basket(-5),
      basket(-5),
    ];
    const { svc } = build(rows, { maxConsecutiveLosses: 8 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.consecutiveLosses).toBe(2);
  });

  it('6. 权益从峰值回撤 ≥ maxDrawdownPct → halt，reason 含「回撤」', async () => {
    // capitalBase=10000，先盈抬高 peak，再巨亏制造 >15% 回撤
    const rows = [basket(2000), basket(-4000)];
    const { svc } = build(rows, { maxConsecutiveLosses: 999, maxDrawdownPct: 15 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.drawdownPct).toBeGreaterThanOrEqual(15);
    expect(v.halt).toBe(true);
    expect(v.reason).toContain('回撤');
  });

  it('7. 回撤未达阈（约 10% < 15%）→ 不 halt', async () => {
    // peak=10000+1000=11000，回撤 1000/11000≈9.09%
    const rows = [basket(1000), basket(-1000)];
    const { svc } = build(rows, { maxConsecutiveLosses: 999, maxDrawdownPct: 15 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.drawdownPct).toBeLessThan(15);
    expect(v.halt).toBe(false);
  });

  it('8. capitalBaseUsdt 抬高 peak 下限，早期负权益不误判除零', async () => {
    // capitalBase=10000，首篮亏 3000 → equity 7000，peak 10000，dd=30%
    // 若不抬高（capitalBase 很小）peak 会被负/低值扭曲。这里断言口径稳定。
    const rows = [basket(-3000)];
    const { svc } = build(rows, { maxConsecutiveLosses: 999, maxDrawdownPct: 15, capitalBaseUsdt: 10_000 });
    const v = await svc.evaluate(INSTANCE);
    expect(Number.isFinite(v.drawdownPct)).toBe(true);
    expect(v.drawdownPct).toBeCloseTo(30, 1);
    expect(v.halt).toBe(true);
  });

  it('9. lookbackBaskets>0 只取最近 N 篮（窗口外亏损不计）', async () => {
    // 8 笔亏损但窗口只 3 → 尾部连续 3 < 阈值 8 → 不 halt
    const rows = Array.from({ length: 8 }, () => basket(-5));
    const { svc } = build(rows, { maxConsecutiveLosses: 8, lookbackBaskets: 3 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.consecutiveLosses).toBe(3);
    expect(v.halt).toBe(false);
  });

  it('10. 多实例隔离：另一实例的亏损篮不影响本实例判定', async () => {
    const other = 'martingale_grid:BTCUSDT';
    const rows = [
      basket(-5, other),
      basket(-5, other),
      basket(-5, other),
      basket(10, INSTANCE),
    ];
    const { svc } = build(rows, { maxConsecutiveLosses: 2 });
    const v = await svc.evaluate(INSTANCE);
    // 本实例只有 1 条盈利篮，尾部连续 0
    expect(v.consecutiveLosses).toBe(0);
    expect(v.halt).toBe(false);
  });

  it('11. 无 CLOSED 篮子 → 不 halt', async () => {
    const { svc } = build([], { maxConsecutiveLosses: 1 });
    const v = await svc.evaluate(INSTANCE);
    expect(v.halt).toBe(false);
  });
});

/** 造一条篮子了结事件（默认归属 INSTANCE） */
function basketClosedEvent(inst: string | null): BasketClosedEvent {
  return {
    code: 'BK-20261001-001',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    layerCount: 1,
    realizedPnl: -5,
    returnPct: -0.001,
    feeTotal: 1,
    fundingFee: 0,
    strategyInstanceId: inst,
    mode: 'dry_run',
    ts: Date.now(),
  };
}

describe('StrategyRunner · 熔断接线（basketClosed → stopInstance → protectionTripped）', () => {
  /** 只接线所需的 Runner：真实事件总线 + 最小 mock 依赖，实例表手动注入 */
  function buildRunner(opts: { running: boolean; halt: boolean }) {
    const events = new EventBusService();
    const evaluate = vi.fn().mockResolvedValue(
      opts.halt
        ? { halt: true, reason: '连亏 8 笔（阈值 8）', consecutiveLosses: 8, drawdownPct: 5 }
        : { halt: false, reason: '', consecutiveLosses: 0, drawdownPct: 0 },
    );
    const protection = { evaluate } as unknown as ProtectionService;
    const listOpenOrders = vi.fn(async () => []);
    const markStopped = vi.fn(async () => undefined);
    const noop = () => undefined;
    const runner = new StrategyRunner(
      noop as never, // registry
      noop as never, // executor
      noop as never, // market
      noop as never, // futuresConfig
      { listOpenOrders } as never, // trading
      noop as never, // positions
      noop as never, // lots
      noop as never, // baskets
      { markStopped } as never, // instanceService
      protection, // protection
      events, // events
    );
    const instances = (runner as unknown as { instances: Map<string, unknown> }).instances;
    if (opts.running) {
      instances.set(INSTANCE, {
        instanceId: INSTANCE,
        strategyName: 'mean_reversion',
        symbol: 'BTCUSDT',
        strategy: {},
        params: {},
        startedAt: new Date(),
      });
    }
    return { events, evaluate, markStopped, instances };
  }

  it('命中熔断：停运行实例 + 清 shouldRun + 发 protectionTripped', async () => {
    const { events, evaluate, markStopped, instances } = buildRunner({ running: true, halt: true });
    const tripped = vi.fn();
    events.on$('protectionTripped').subscribe(tripped);

    events.emit('basketClosed', basketClosedEvent(INSTANCE));
    await vi.waitFor(() => expect(tripped).toHaveBeenCalledTimes(1));
    expect(evaluate).toHaveBeenCalledWith(INSTANCE);
    expect(markStopped).toHaveBeenCalledWith(INSTANCE);
    expect(instances.has(INSTANCE)).toBe(false);
    const payload = tripped.mock.calls[0][0];
    expect(payload.instanceId).toBe(INSTANCE);
    expect(payload.strategyName).toBe('mean_reversion');
    expect(payload.reason).toContain('连亏');
  });

  it('未命中：不停实例、不发事件', async () => {
    const { events, evaluate, markStopped, instances } = buildRunner({ running: true, halt: false });
    const tripped = vi.fn();
    events.on$('protectionTripped').subscribe(tripped);
    events.emit('basketClosed', basketClosedEvent(INSTANCE));
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledWith(INSTANCE));
    expect(markStopped).not.toHaveBeenCalled();
    expect(tripped).not.toHaveBeenCalled();
    expect(instances.has(INSTANCE)).toBe(true);
  });

  it('无 strategyInstanceId：不评估', async () => {
    const { events, evaluate } = buildRunner({ running: true, halt: true });
    events.emit('basketClosed', basketClosedEvent(null));
    await Promise.resolve();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('非运行实例（已停/别的实例）：不评估', async () => {
    const { events, evaluate } = buildRunner({ running: false, halt: true });
    events.emit('basketClosed', basketClosedEvent(INSTANCE));
    await Promise.resolve();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
