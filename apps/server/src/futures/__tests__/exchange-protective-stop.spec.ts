import { describe, expect, it } from 'vitest';
import { FuturesTradingService } from '../futures-trading.service';

/**
 * 交易所侧灾难保险丝（exchange protective stop）Phase 1 验收。
 * 注意：与 strategy/protection.service.ts（篮子级亏损熔断 ProtectionsConfig）是两回事，
 * 本 spec 只测 futures-trading 的 PROTECTION 挂单/撤单/归因/对账。
 *
 * 覆盖 docs/exchange-protection-orders-plan.md §9 Phase1 单测项：
 * - 灾难价 I-2（先于强平）约束与收窄
 * - PROTECTION_MODE=off 零副作用
 * - fixed + testnet 挂单（source PROTECTION、reduceOnly、反向 side、positionSide、priceProtect）
 * - detach 拆保险丝
 * - reconcileProtections 缺挂补挂 + 幂等
 */

type AnyLot = {
  id: string;
  market: 'futures' | 'spot';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  protectionOrderId: string | null;
  protectedStopPrice: number;
  strategyInstanceId: string | null;
  status: string;
  leverage: number;
};

function lot(over: Partial<AnyLot> = {}): AnyLot {
  return {
    id: 'lot-1',
    market: 'futures',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: 0.01,
    entryPrice: 100_000,
    protectionOrderId: null,
    protectedStopPrice: 0,
    strategyInstanceId: 'x:BTCUSDT',
    status: 'OPEN',
    leverage: 10,
    ...over,
  };
}

const FILTERS = {
  symbol: 'BTCUSDT',
  stepSize: 0.001,
  tickSize: 0.1,
  minQty: 0.001,
  maxQty: 1000,
  minNotional: 0,
};

function harness(
  opts: {
    mode?: 'off' | 'fixed' | 'trailing';
    runMode?: 'testnet' | 'live';
    defaultPct?: string;
    leverage?: number;
  } = {},
) {
  const lotsById = new Map<string, AnyLot>();
  const ordersById = new Map<string, any>();
  const placed: any[] = [];
  const canceled: any[] = [];
  const attachLog: any[] = [];
  const clearLog: string[] = [];
  let orderSeq = 1;
  let openAlgo: any[] = [];

  const getLot = (id: string) => lotsById.get(id) ?? null;

  const orderRepo: any = {
    create: (o: any) => ({ ...o, id: `ord-${orderSeq++}` }),
    save: (o: any) => {
      const s = { ...o };
      ordersById.set(s.id, s);
      return Promise.resolve(s);
    },
    findOne: ({ where }: any) => {
      if (where?.id) return Promise.resolve(ordersById.get(where.id) ?? null);
      if (where?.clientOrderId) {
        return Promise.resolve(
          [...ordersById.values()].find((x) => x.clientOrderId === where.clientOrderId) ?? null,
        );
      }
      return Promise.resolve(null);
    },
    find: () => Promise.resolve([]),
    update: () => Promise.resolve({ affected: 1 }),
  };
  const fillRepo: any = {
    create: (x: any) => x,
    save: (x: any) => Promise.resolve(x),
    find: () => Promise.resolve([]),
    findOne: () => Promise.resolve(null),
    createQueryBuilder: () => ({ select: () => ({ getRawMany: () => Promise.resolve([]) }) }),
  };

  const adapter: any = {
    getSymbolFilters: () => Promise.resolve(FILTERS),
    setLeverage: () => Promise.resolve({}),
    setMarginType: () => Promise.resolve({}),
    placeOrder: (i: any) => {
      placed.push(i);
      return Promise.resolve({
        exchangeOrderId: `algo-${placed.length}`,
        clientOrderId: i.clientOrderId,
        symbol: i.symbol,
        side: i.side,
        type: i.type,
        status: 'NEW',
        filledQuantity: 0,
        filledPrice: 0,
      });
    },
    cancelOrder: (i: any) => {
      canceled.push(i);
      return Promise.resolve({});
    },
    getOpenOrders: () => Promise.resolve(openAlgo),
    getOrder: () => Promise.resolve({ filledQuantity: 0, status: 'NEW' }),
  };

  const registry: any = { get: () => Promise.resolve(adapter) };
  const futuresConfig: any = {
    get: () =>
      Promise.resolve({
        mode: opts.runMode ?? 'testnet',
        symbol: 'BTCUSDT',
        leverage: opts.leverage ?? 10,
        marginType: 'isolated',
      }),
  };
  const events: any = { emit: () => {} };
  const positions: any = {};
  const overrides: Record<string, string> = {
    PROTECTION_MODE: opts.mode ?? 'off',
    PROTECTION_DEFAULT_PCT: opts.defaultPct ?? '5',
    PROTECTION_FLOOR_RATIO: '1.2',
    PROTECTION_RECONCILE_SEC: '300',
  };
  const config: any = { get: (k: string, d?: string) => overrides[k] ?? d };

  const lots: any = {
    getLotById: (id: string) => Promise.resolve(getLot(id)),
    getOpenLot: (id: string) => Promise.resolve(getLot(id)),
    createFromOpenFill: () => Promise.resolve(null),
    settleFromCloseFill: () => Promise.resolve(null),
    attachProtection: (id: string, orderId: string, stop: number) => {
      const l = getLot(id);
      if (l) {
        l.protectionOrderId = orderId;
        l.protectedStopPrice = stop;
      }
      attachLog.push([id, orderId, stop]);
      return Promise.resolve();
    },
    clearProtection: (id: string) => {
      const l = getLot(id);
      if (l) {
        l.protectionOrderId = null;
        l.protectedStopPrice = 0;
      }
      clearLog.push(id);
      return Promise.resolve();
    },
    listOpen: () => Promise.resolve([...lotsById.values()].filter((l) => l.status === 'OPEN')),
    listOrphanProtections: () =>
      Promise.resolve([...lotsById.values()].filter((l) => l.protectionOrderId && l.status !== 'OPEN')),
  };

  const svc = new FuturesTradingService(
    orderRepo,
    fillRepo,
    registry,
    futuresConfig,
    positions,
    events,
    config,
    lots,
  );
  return {
    svc,
    lotsById,
    ordersById,
    placed,
    canceled,
    attachLog,
    clearLog,
    setOpenAlgo: (a: any[]) => {
      openAlgo = a;
    },
  };
}

describe('灾难保险丝 · resolveProtectionStopPrice（I-2 先于强平约束）', () => {
  const { svc } = harness({ mode: 'fixed' });
  const calc = (a: any) => (svc as any).resolveProtectionStopPrice(a);

  it('未声明 → 默认 5% 被 10x 杠杆安全区（4.75%）收窄', () => {
    expect(calc({ direction: 'LONG', entryPrice: 100_000, leverage: 10 })).toBeCloseTo(95_250, 0);
  });
  it('声明价越出强平安全区（亏损 6% > 4.75%）→ 收窄到安全区内', () => {
    expect(calc({ direction: 'LONG', entryPrice: 100_000, leverage: 10, declared: 94_000 })).toBeCloseTo(
      95_250,
      0,
    );
  });
  it('声明价在安全区内（亏损 4%）→ 原样采用', () => {
    expect(calc({ direction: 'LONG', entryPrice: 100_000, leverage: 10, declared: 96_000 })).toBeCloseTo(
      96_000,
      0,
    );
  });
  it('declared=null → 显式关闭返回 null', () => {
    expect(calc({ direction: 'LONG', entryPrice: 100_000, leverage: 10, declared: null })).toBeNull();
  });
  it('SHORT 20x → 安全区 2.375%（+价方向）', () => {
    expect(calc({ direction: 'SHORT', entryPrice: 100_000, leverage: 20 })).toBeCloseTo(102_375, 0);
  });
});

describe('PROTECTION_MODE=off → 零副作用', () => {
  it('attach/reconcile/detach 全短路，不发单、不写库', async () => {
    const { svc, lotsById, placed, attachLog, clearLog } = harness({ mode: 'off' });
    lotsById.set('lot-1', lot());
    await svc.attachProtectionForLot(lot() as any, 10);
    expect(placed.length).toBe(0);
    expect(attachLog.length).toBe(0);

    const r = await svc.reconcileProtections();
    expect(r).toEqual({ attached: 0, replaced: 0, orphans: 0 });

    await svc.detachProtectionForLot('lot-1');
    expect(clearLog.length).toBe(0);
    expect(lotsById.get('lot-1')!.protectionOrderId).toBeNull();
  });
});

describe('fixed + testnet 注册保险丝', () => {
  it('真实发单（algoOrder）并建 PROTECTION 本地订单，回写 lot 字段', async () => {
    const { svc, lotsById, ordersById, attachLog, placed } = harness({ mode: 'fixed', runMode: 'testnet' });
    const l = lot();
    lotsById.set('lot-1', l);

    await svc.attachProtectionForLot(l as any, 10);

    // dry_run 已移除（2026-10-15）：保险丝必须真实注册到交易所
    expect(placed.length).toBe(1);
    expect(attachLog.length).toBe(1);

    const order = [...ordersById.values()].find((o) => o.source === 'PROTECTION');
    expect(order).toBeTruthy();
    expect(order.type).toBe('STOP_MARKET');
    expect(order.reduceOnly).toBe(true); // 本地记平仓意图
    expect(order.side).toBe('SELL'); // LONG 的反向平仓
    expect(order.positionSide).toBe('LONG');
    expect(order.lotId).toBe('lot-1');
    expect(order.status).toBe('NEW');
    expect(Number(order.stopPrice)).toBeCloseTo(95_250, 0);
    expect(lotsById.get('lot-1')!.protectionOrderId).toBe(order.id);
  });
});

describe('fixed + testnet 发 algoOrder 带 priceProtect', () => {
  it('adapter.placeOrder 收到 priceProtect=true', async () => {
    const { svc, lotsById, placed } = harness({ mode: 'fixed', runMode: 'testnet' });
    const l = lot();
    lotsById.set('lot-1', l);

    await svc.attachProtectionForLot(l as any, 10);

    expect(placed.length).toBe(1);
    expect(placed[0].priceProtect).toBe(true);
    expect(placed[0].type).toBe('STOP_MARKET');
    expect(placed[0].side).toBe('SELL');
    expect(placed[0].positionSide).toBe('LONG');
  });
});

describe('detach 拆保险丝', () => {
  it('有 protectionOrderId → clearProtection 被调（撤单失败也照样清）', async () => {
    const { svc, lotsById, clearLog } = harness({ mode: 'fixed', runMode: 'testnet' });
    // ord-old 不在 ordersById → cancelOrder 抛 NOT_FOUND → 被 detach 吞掉 → finally 仍清
    lotsById.set('lot-1', lot({ protectionOrderId: 'ord-old', protectedStopPrice: 95_250 }));

    await svc.detachProtectionForLot('lot-1');

    expect(clearLog).toContain('lot-1');
    expect(lotsById.get('lot-1')!.protectionOrderId).toBeNull();
  });
});

describe('reconcileProtections 缺挂补挂 + 幂等', () => {
  it('OPEN 缺挂补挂一次；再次运行不重复挂', async () => {
    const { svc, lotsById, ordersById, attachLog } = harness({ mode: 'fixed', runMode: 'testnet' });
    lotsById.set('lot-1', lot()); // 无 protectionOrderId

    const r1 = await svc.reconcileProtections();
    expect(r1.attached).toBe(1);
    expect(attachLog.length).toBe(1);
    const oid = lotsById.get('lot-1')!.protectionOrderId!;
    expect(ordersById.get(oid).status).toBe('NEW');

    // 再跑：已有存活保险丝（NEW、数量匹配）→ 不重复挂、不换单
    const r2 = await svc.reconcileProtections();
    expect(r2.attached).toBe(0);
    expect(r2.replaced).toBe(0);
    expect(attachLog.length).toBe(1);
  });

  it('孤儿：CLOSED 却仍挂 NEW → 撤并清', async () => {
    const { svc, lotsById, ordersById, clearLog } = harness({ mode: 'fixed', runMode: 'testnet' });
    const orphan = lot({ id: 'lot-x', status: 'CLOSED', protectionOrderId: 'ord-x' });
    lotsById.set('lot-x', orphan);
    // 把 ord-x 登记成一个仍 NEW 的保险丝单
    ordersById.set('ord-x', { id: 'ord-x', status: 'NEW', clientOrderId: 'pt_lot-x_1', quantity: 0.01 });

    const r = await svc.reconcileProtections();
    expect(r.orphans).toBe(1);
    expect(clearLog).toContain('lot-x');
    expect(lotsById.get('lot-x')!.protectionOrderId).toBeNull();
  });
});
