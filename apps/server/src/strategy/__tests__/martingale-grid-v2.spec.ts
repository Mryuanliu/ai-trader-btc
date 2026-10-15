// 马丁网格 V2 · 关断态回归（E0 的单元级前身）：
// 全部 V2 开关默认关时，新策略的每个交易动作必须与老策略逐位一致。
// 语料级 diff=0 由 E0 回测实验完成，这里先钉住行为级等价。
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { MartingaleGridStrategy } from '../martingale-grid.strategy';
import { MartingaleGridV2Strategy } from '../martingale-grid-v2.strategy';
import type { StrategyContext, StrategyExecutor, StrategyLotView } from '../types';

function makeCandles(price = 100_000, count = 80): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: price,
    high: price + 50,
    low: price - 50,
    close: price,
    volume: 1,
  }));
}

function makeLot(overrides: Partial<StrategyLotView> = {}): StrategyLotView {
  return {
    id: 'lot-1',
    direction: 'LONG',
    quantity: 0.001,
    entryPrice: 100_000,
    unrealizedPnl: 0,
    openedAt: new Date().toISOString(),
    hasPendingClose: false,
    ...overrides,
  };
}

/** 与老策略 spec 同款记录器：捕获策略发出的全部动作 */
function makeExecutor() {
  const stops: { direction: string; stopPrice: number; quantity: number; leverage: number }[] = [];
  const opens: { direction: string; quantity: number; reason: string }[] = [];
  const closes: { lotId: string; reason: string }[] = [];
  const cancels: string[] = [];
  const executor: StrategyExecutor = {
    async openLot(input) {
      opens.push({ direction: input.direction, quantity: input.quantity, reason: input.reason });
      return { lotId: 'lot-new' };
    },
    async closeLot(lotId, reason) {
      closes.push({ lotId, reason });
      return { ok: true };
    },
    async placeStopOrder(input) {
      stops.push({
        direction: input.direction,
        stopPrice: input.stopPrice,
        quantity: input.quantity,
        leverage: input.leverage ?? 0,
      });
      return { orderId: `ord-${stops.length}` };
    },
    async cancelOrder(orderId) {
      cancels.push(orderId);
      return { ok: true };
    },
  };
  return { executor, stops, opens, closes, cancels };
}

function makeContext(
  params: Record<string, unknown>,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    symbol: 'BTCUSDT',
    instanceId: 'martingale_grid:BTCUSDT',
    price: 100_000,
    markPrice: 100_000,
    atr: 100,
    candles: makeCandles(),
    openLots: [],
    openOrders: [],
    availableMargin: 5000,
    netQty: 0,
    params,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

describe('MartingaleGridV2Strategy · 身份与参数', () => {
  it('独立身份：不覆盖老策略注册名', () => {
    const v2 = new MartingaleGridV2Strategy();
    const old = new MartingaleGridStrategy();
    expect(v2.name).toBe('martingale_grid_v2');
    expect(old.name).toBe('martingale_grid');
    expect(v2.label).toContain('King');
  });

  it('V2 机制开关默认全关（关断态 = 老策略基线）', () => {
    const p = new MartingaleGridV2Strategy().normalizeParams(null);
    for (const k of [
      'useBrain',
      'useScoreSizing',
      'usePendingDiscipline',
      'useExitChain',
      'usePivotCarry',
      'useExtremeGuard',
      'pauseAroundFunding',
    ]) {
      expect(p[k]).toBe(false);
    }
  });

  it('老 20 参同名同默认值（基线可对账）', () => {
    const v2 = new MartingaleGridV2Strategy().normalizeParams(null);
    const old = new MartingaleGridStrategy().normalizeParams(null);
    for (const k of Object.keys(old)) {
      expect(v2[k]).toEqual((old as Record<string, unknown>)[k]);
    }
  });

  it('V2 数值参数按 §5 换算表落位', () => {
    const p = new MartingaleGridV2Strategy().normalizeParams(null);
    expect(p.trendRange).toBe(20);
    expect(p.trendConfirm).toBe(45);
    expect(p.trendStrong).toBe(70);
    expect(p.trendDirEnter).toBe(26);
    expect(p.trendDirExit).toBe(14);
    expect(p.chopGate).toBe(0.58);
    expect(p.marginGuardFree).toBe(1.15);
    expect(p.marginGuardEquity).toBe(1.25);
    expect(p.minTriggerDistPct).toBe(0.0005);
  });

  it('策略永不因参数崩溃：非法值一律回落', () => {
    const p = new MartingaleGridV2Strategy().normalizeParams({
      baseQty: 'abc',
      trendDirEnter: Number.NaN,
      chopGate: 99,
      useBrain: undefined,
    } as never);
    expect(Number.isFinite(p.baseQty as number)).toBe(true);
    expect(p.trendDirEnter).toBe(26);
    expect(p.chopGate).toBe(1); // 越界钳制
    expect(p.useBrain).toBe(false);
  });
});

describe('MartingaleGridV2Strategy · 关断态行为等价（E0 行为级）', () => {
  /** 对同一输入序列并跑新旧策略，断言动作轨迹完全一致 */
  const parity = async (
    raw: Record<string, unknown>,
    steps: Array<Partial<StrategyContext>>,
  ) => {
    const oldS = new MartingaleGridStrategy();
    const v2S = new MartingaleGridV2Strategy();
    const oldParams = oldS.normalizeParams(raw);
    const v2Params = v2S.normalizeParams(raw);
    oldS.onStart?.(oldParams);
    v2S.onStart?.(v2Params);
    const oldRec = makeExecutor();
    const v2Rec = makeExecutor();
    for (const s of steps) {
      await oldS.onTick(makeContext(oldParams, s), oldRec.executor);
      await v2S.onTick(makeContext(v2Params, s), v2Rec.executor);
    }
    expect(v2Rec.stops).toEqual(oldRec.stops);
    expect(v2Rec.opens).toEqual(oldRec.opens);
    expect(v2Rec.closes).toEqual(oldRec.closes);
    expect(v2Rec.cancels).toEqual(oldRec.cancels);
    // 可观测快照的关键数值口径也一致
    const o = oldS.getState();
    const v = v2S.getState();
    expect(v.basketPeakPct).toEqual(o.basketPeakPct);
    expect(v.netPct).toEqual(o.netPct);
    expect(v.ladder).toEqual(o.ladder);
  };

  it('空仓启动：双向首层 STOP 挂单一致', async () => {
    await parity({ useTrendFilter: false, firstOrderMarket: false }, [{}]);
  });

  it('firstOrderMarket 开：市价首层 + 后续网格路径一致', async () => {
    await parity({ useTrendFilter: false }, [{}, { openLots: [makeLot()] }]);
  });

  it('加层抑制与走远加层：1 格判定行为原样继承（G9 待 W4 修正，非 W0 差异）', async () => {
    await parity(
      { useTrendFilter: false, stepAtrMult: 1, minStepPct: 0.002, maxStepPct: 0.03 },
      [
        { openLots: [makeLot({ entryPrice: 99_900 })] }, // 未走远 → 不加
        { openLots: [makeLot({ entryPrice: 99_500 })] }, // 走远 1 格 → 挂
      ],
    );
  });

  it('篮子追踪止盈全链路：峰值→回撤→撤单→全平', async () => {
    const lot = makeLot({ quantity: 0.001, entryPrice: 100_000 });
    await parity(
      { useTrendFilter: false, basketStartPct: 0.015, basketGivebackPct: 0.005 },
      [
        { openLots: [{ ...lot, unrealizedPnl: 5 }] },
        { openLots: [{ ...lot, unrealizedPnl: 4 }] },
      ],
    );
  });

  it('固定止损 + 残单先撤：出场序列一致', async () => {
    await parity(
      { useTrendFilter: false, basketStopLossUsdt: 2 },
      [
        {
          openLots: [makeLot({ unrealizedPnl: -2.5 })],
          openOrders: [
            { id: 'pending-1', side: 'BUY', type: 'STOP_MARKET', stopPrice: 100_100, quantity: 0.001, exchangeOrderId: 'ex-1' },
          ],
        },
      ],
    );
  });

  it('单侧金字塔：持多不挂空', async () => {
    await parity({ useTrendFilter: true }, [{ openLots: [makeLot({ direction: 'LONG' })] }]);
  });

  it('层数上限挡位一致', async () => {
    const lots = Array.from({ length: 6 }, (_, i) =>
      makeLot({ id: `lot-${i}`, entryPrice: 100_000 + i * 100 }),
    );
    await parity({ useTrendFilter: false, maxLayersPerSide: 6 }, [{ openLots: lots }]);
  });
});

describe('MartingaleGridV2Strategy · M2/M1 开启态行为（强趋势 fixture）', () => {
  /** 1200 根线性上行：三框架都吃满，Brain 满分区（score≈100） */
  function upCandles(): Candle[] {
    return Array.from({ length: 1200 }, (_, i) => {
      const c = 100_000 + i * 10;
      const prev = i > 0 ? 100_000 + (i - 1) * 10 : c;
      return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: c + 5, low: prev - 5, close: c, volume: 1 };
    });
  }

  const v2Driven = async (raw: Record<string, unknown>, steps: Partial<StrategyContext>[]) => {
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams(raw);
    s.onStart?.(params);
    const rec = makeExecutor();
    for (const st of steps) {
      await s.onTick(makeContext(params, { candles: upCandles(), ...st }), rec.executor);
    }
    return { s, rec, params };
  };

  it('趋势压平倍率：强趋势下 L2 手数回退近等权（1.8× → ≈1.0×）', async () => {
    const { rec } = await v2Driven(
      { useTrendFilter: false, enabledSides: 'longOnly', useScoreSizing: true, lotMultiplier: 1.8, firstOrderMarket: false },
      [{ openLots: [makeLot({ entryPrice: 112_000 })] }], // 现价 100000 已走远 → 挂 L2；LONG=顺势侧
    );
    expect(rec.stops).toHaveLength(1);
    // 震荡域应是 0.01×1.8=0.018；强趋势压平到 trendMultMin=1.0 → 0.01
    expect(rec.stops[0].quantity).toBeCloseTo(0.01, 8);
  });

  it('方向不对称间距：强趋势顺势侧（LONG）间距加密至 ≈0.75×s0', async () => {
    const raw = { useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false, stepAtrMult: 1, minStepPct: 0.002, maxStepPct: 0.03 };
    const off = await v2Driven(raw, [{ openLots: [makeLot({ entryPrice: 112_000 })] }]);
    const on = await v2Driven({ ...raw, useScoreSizing: true }, [{ openLots: [makeLot({ entryPrice: 112_000 })] }]);
    expect(off.rec.stops).toHaveLength(1);
    expect(on.rec.stops).toHaveLength(1);
    // 基准 s0=200（被 minStepPct 地板抬到 0.2%×现价）；此 fixture Brain ≈85 分
    // → 顺势系数 1−0.25×(85−45)/55≈0.818 → step≈164，必小于 s0 且不低于 0.7×s0
    expect(off.rec.stops[0].stopPrice).toBeCloseTo(100_200, 0);
    expect(on.rec.stops[0].stopPrice).toBeGreaterThan(100_140); // ≥ 0.7×s0 护栏
    expect(on.rec.stops[0].stopPrice).toBeLessThan(off.rec.stops[0].stopPrice); // 加密
  });

  it('useBrain 定向：强趋势只放多头侧（粘滞 dir=+1）', async () => {
    const { rec } = await v2Driven(
      { useTrendFilter: true, useBrain: true, firstOrderMarket: false },
      [{}],
    );
    const dirs = rec.stops.map((x) => x.direction);
    expect(dirs).toContain('LONG');
    expect(dirs).not.toContain('SHORT');
  });

  it('M2 开关互斥性：useScoreSizing 单独开启也能拉 regime（无 useBrain 依赖）', async () => {
    const { s } = await v2Driven(
      { useTrendFilter: false, useScoreSizing: true, firstOrderMarket: false },
      [{}],
    );
    const snap = (s as unknown as { regimeSnap: { score: number } | null }).regimeSnap;
    expect(snap).not.toBeNull();
    expect(snap!.score).toBeGreaterThan(45);
  });
});

describe('MartingaleGridV2Strategy · M3 挂单纪律开启态（usePendingDiscipline）', () => {
  /** 扁平市：price=100_000、atr=100 → 默认地板下 step=300（0.3%） */
  const v2Flat = async (raw: Record<string, unknown>, steps: Partial<StrategyContext>[]) => {
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams(raw);
    s.onStart?.(params);
    const rec = makeExecutor();
    for (const st of steps) {
      await s.onTick(makeContext(params, st), rec.executor);
    }
    return { s, rec };
  };
  const ord = (id: string, side: 'BUY' | 'SELL', stopPrice: number, quantity = 0.01) => ({
    id,
    side,
    type: 'STOP_MARKET',
    stopPrice,
    quantity,
    exchangeOrderId: `ex-${id}`,
  });
  // stepAtrMult:3 + 地板/上限放宽 → step 恒为 atr(100)×3=300，与 ctx.price 浮动无关（断言可手算）
  const base = { useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false, stepAtrMult: 3, minStepPct: 0.0001, maxStepPct: 0.03 };
  const disc = { ...base, usePendingDiscipline: true };

  it('G9 两格回归：逆行 1 格拒绝（老行为会挂），逆行 2 格才挂确认单', async () => {
    const near = await v2Flat(disc, [{ openLots: [makeLot({ entryPrice: 100_000 })], price: 99_700 }]);
    expect(near.rec.stops).toHaveLength(0);
    const offNear = await v2Flat(base, [{ openLots: [makeLot({ entryPrice: 100_000 })], price: 99_700 }]);
    expect(offNear.rec.stops).toHaveLength(1); // 关断态保留 1 格老近似（E0 基线）

    const far = await v2Flat(disc, [{ openLots: [makeLot({ entryPrice: 100_000 })], price: 99_400 }]);
    expect(far.rec.stops).toHaveLength(1);
    expect(far.rec.stops[0].stopPrice).toBeCloseTo(99_700, 6); // 现价外侧 1 格：反弹确认单
  });

  it('G9 再平衡：失衡资格成立且突破本方极值 → 允许顺向挂层', async () => {
    const steps: Partial<StrategyContext>[] = [
      {
        price: 100_100,
        openLots: [makeLot({ entryPrice: 100_000, quantity: 0.01 }), makeLot({ id: 'lot-s', direction: 'SHORT', entryPrice: 99_000, quantity: 0.05 })],
      },
    ];
    const on = await v2Flat(disc, steps);
    expect(on.rec.stops).toHaveLength(1);
    expect(on.rec.stops[0].direction).toBe('LONG');
    expect(on.rec.stops[0].stopPrice).toBeCloseTo(100_400, 6); // price+step（floor 0.05% 不改变）
    const off = await v2Flat(base, steps);
    expect(off.rec.stops).toHaveLength(0); // 关断态：LONG 侧未逆行 → 不挂
  });

  it('G8 挂单跟踪：只向现价方向、偏离≥地板才撤旧换新；关断态不动残单', async () => {
    const steps: Partial<StrategyContext>[] = [
      { price: 99_300, openLots: [makeLot({ entryPrice: 100_000 })], openOrders: [ord('ord-p1', 'BUY', 100_000)] },
    ];
    const on = await v2Flat(disc, steps);
    expect(on.rec.cancels).toEqual(['ord-p1']);
    expect(on.rec.stops).toHaveLength(1);
    expect(on.rec.stops[0].stopPrice).toBeCloseTo(99_600, 6); // 99_300+300，手数沿用旧单
    expect(on.rec.stops[0].quantity).toBeCloseTo(0.01, 8);
    const off = await v2Flat(base, steps);
    expect(off.rec.cancels).toHaveLength(0);
    expect(off.rec.stops).toHaveLength(0); // 老行为：有残单直接 return
  });

  it('M3-4 侧上限撤挡：已成交达帽 → 撤本侧挡单；关断态不撤', async () => {
    const lots = Array.from({ length: 4 }, (_, i) => makeLot({ id: `lot-${i}`, entryPrice: 100_000 + i * 100 }));
    const steps: Partial<StrategyContext>[] = [{ openLots: lots, openOrders: [ord('ord-cap', 'BUY', 100_500)] }];
    const on = await v2Flat({ ...disc, maxLayersPerSide: 4 }, steps);
    expect(on.rec.cancels).toEqual(['ord-cap']);
    const off = await v2Flat({ ...base, maxLayersPerSide: 4 }, steps);
    expect(off.rec.cancels).toHaveLength(0);
  });

  it('M3-5 保证金预检：可用不足 → 拒挂并写 note；关断态照挂', async () => {
    const step: Partial<StrategyContext> = { price: 99_400, openLots: [makeLot({ entryPrice: 100_000 })], availableMargin: 20 };
    const on = await v2Flat(disc, [step]);
    expect(on.rec.stops).toHaveLength(0);
    expect((on.s.getState() as Record<string, unknown>).note).toContain('保证金预检');
    const off = await v2Flat(base, [step]);
    expect(off.rec.stops).toHaveLength(1);
  });

  it('M3-7 出场 arm 即撤挂单：峰值达启动线后维持空挂单；关断态残单不撤', async () => {
    const rich = makeLot({ entryPrice: 100_000, quantity: 0.001, unrealizedPnl: 20 }); // netPct ≈19.95% ≥ 1.5% 启动线
    const steps: Partial<StrategyContext>[] = [
      { openLots: [rich], openOrders: [ord('ord-arm', 'BUY', 101_000)] },
      { openLots: [rich], openOrders: [ord('ord-arm', 'BUY', 101_000)] },
    ];
    const on = await v2Flat({ ...disc, enabledSides: 'both' }, steps);
    expect(on.rec.cancels).toContain('ord-arm');
    expect(on.rec.closes).toHaveLength(0); // 未触发 giveback，不出场
    const off = await v2Flat({ ...base, enabledSides: 'both' }, steps);
    expect(off.rec.cancels).toHaveLength(0);
  });

  it('M3-6 首 K 线锁：同根 K 线不重复市价首层，下一根才允许重试', async () => {
    const t0 = 1_700_000_000_000 + 79 * 60_000; // makeCandles 最后一根
    const nextBar = makeCandles().map((c, i, a) => (i === a.length - 1 ? { ...c, time: c.time + 60_000 } : c));
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams({ ...base, firstOrderMarket: true });
    s.onStart?.(params);
    const rec = makeExecutor();
    await s.onTick(makeContext(params, { now: t0 }), rec.executor);
    expect(rec.opens).toHaveLength(1);
    await s.onTick(makeContext(params, { now: t0 + 1000 }), rec.executor); // 同根（candles 未变）
    expect(rec.opens).toHaveLength(1);
    await s.onTick(makeContext(params, { now: t0 + 61_000, candles: nextBar }), rec.executor); // 新根
    expect(rec.opens).toHaveLength(2);
  });

  it('M3-5 funding 窗暂停开层：结算前 ±15min 不挂新单（独立开关）', async () => {
    const boundary = 3 * 8 * 3600_000; // UTC 对齐的 8h 结算点
    const step: Partial<StrategyContext> = { now: boundary - 60_000 };
    const on = await v2Flat({ ...disc, pauseAroundFunding: true }, [step]);
    expect(on.rec.stops).toHaveLength(0);
    expect((on.s.getState() as Record<string, unknown>).note).toContain('funding');
    const off = await v2Flat({ ...disc, pauseAroundFunding: false }, [step]);
    expect(off.rec.stops).toHaveLength(1); // 首层照挂
  });
});

describe('MartingaleGridV2Strategy · M4 出场优先级链开启态（useExitChain）', () => {
  const v2Flat = async (raw: Record<string, unknown>, steps: Partial<StrategyContext>[]) => {
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams(raw);
    s.onStart?.(params);
    const rec = makeExecutor();
    for (const st of steps) {
      await s.onTick(makeContext(params, st), rec.executor);
    }
    return { s, rec };
  };
  const ord = (id: string, side: 'BUY' | 'SELL', stopPrice: number, quantity = 0.01) => ({
    id,
    side,
    type: 'STOP_MARKET',
    stopPrice,
    quantity,
    exchangeOrderId: `ex-${id}`,
  });
  // step 钉 300；triggerPriceType=last → 判定价=ctx.price，避开 markPrice 默认值干扰
  const chain = {
    useTrendFilter: false,
    enabledSides: 'longOnly',
    firstOrderMarket: false,
    stepAtrMult: 3,
    minStepPct: 0.0001,
    maxStepPct: 0.03,
    useExitChain: true,
    triggerPriceType: 'last',
  };
  const oldLot = (o: Partial<StrategyLotView> = {}): StrategyLotView =>
    makeLot({ quantity: 0.01, entryPrice: 100_000, openedAt: '2020-01-01T00:00:00Z', ...o });

  it('M4-1 首单追踪（G7）：窗口内钱达标 arm → 判定价回撤 1 格即平；关断态不动', async () => {
    const fresh = makeLot({ quantity: 0.01, entryPrice: 100_000, unrealizedPnl: 5 }); // net=4.6 ≥ 1格金额 3
    const steps: Partial<StrategyContext>[] = [
      { openLots: [{ ...fresh, openedAt: new Date(1_700_000_000_000).toISOString() }] }, // now−opened=0 → 窗口内
      { openLots: [{ ...fresh, openedAt: new Date(1_700_000_000_000).toISOString() }], price: 99_600 }, // 峰 100000 回撤 400 ≥ step
    ];
    const on = await v2Flat(chain, steps);
    expect(on.rec.closes).toHaveLength(1);
    expect(on.rec.closes[0]).toEqual({ lotId: 'lot-1', reason: 'TAKE_PROFIT' });
    expect((on.s.getState() as Record<string, unknown>).note).toContain('首单追踪离场');
    const off = await v2Flat({ ...chain, useExitChain: false }, steps);
    expect(off.rec.closes).toHaveLength(0); // 兑底链：netPct 0.46% 未达启动线
  });

  it('M4-2 篮子双口径（G14）：钱达标 arm+撤残单 → 下 tick 只监控价格回撤，回撤离场全平', async () => {
    const rich = oldLot({ unrealizedPnl: 25 }); // net=24.6 ≥ 名义×1.5%+1格金额=18；侧目标抬到 5% 避免先走侧平
    const steps: Partial<StrategyContext>[] = [
      { openLots: [rich], openOrders: [ord('ord-t2', 'BUY', 100_400)], netQty: 0.01 },
      { openLots: [rich], netQty: 0.01, price: 99_100 }, // 峰 100000 回撤 0.9% ≥ 0.8%
    ];
    const on = await v2Flat({ ...chain, sideTargetPct: 0.05 }, steps);
    expect(on.rec.cancels).toEqual(['ord-t2']); // arm 即撤挂单
    expect(on.rec.closes).toEqual([{ lotId: 'lot-1', reason: 'TAKE_PROFIT' }]);
    expect((on.s.getState() as Record<string, unknown>).note).toContain('篮子追踪离场');
  });

  it('M4-3 震荡域侧目标直平：只撤同向残单、逐单 TAKE_PROFIT', async () => {
    const hit = oldLot({ unrealizedPnl: 10 }); // net=9.6 ≥ 名义×0.6%=6
    const { rec } = await v2Flat(chain, [
      { openLots: [hit], openOrders: [ord('ord-b', 'BUY', 100_400), ord('ord-s', 'SELL', 99_600)] },
    ]);
    expect(rec.cancels).toEqual(['ord-b']); // 只撤同向（BUY）挡单
    expect(rec.closes).toEqual([{ lotId: 'lot-1', reason: 'TAKE_PROFIT' }]);
  });

  it('M4-4 趋势域配对减（G6）：顺势侧达标+逆势小亏单 → 两段式双平，归因 SIGNAL', async () => {
    function upCandles(): Candle[] {
      return Array.from({ length: 1200 }, (_, i) => {
        const c = 100_000 + i * 10;
        const prev = i > 0 ? 100_000 + (i - 1) * 10 : c;
        return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: c + 5, low: prev - 5, close: c, volume: 1 };
      });
    }
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams({ ...chain, sideTargetPct: 0.006 });
    s.onStart?.(params);
    const rec = makeExecutor();
    await s.onTick(
      makeContext(params, {
        candles: upCandles(),
        price: 111_990,
        netQty: 0.009,
        openLots: [
          oldLot({ direction: 'LONG', entryPrice: 110_000, quantity: 0.01, unrealizedPnl: 19.9 }), // 净 19.46 ≥ 侧目标 ≈9.8（顺势 ×1.49）
          oldLot({ id: 'lot-s', direction: 'SHORT', entryPrice: 111_500, quantity: 0.001, unrealizedPnl: -0.49 }), // 净 −0.54
        ],
        openOrders: [ord('ord-p', 'BUY', 112_300)],
      }),
      rec.executor,
    );
    expect(rec.cancels).toEqual(['ord-p']); // 两段式：先撤全部挂单
    expect(rec.closes).toHaveLength(2);
    expect(rec.closes.every((c) => c.reason === 'SIGNAL')).toBe(true);
    expect((s.getState() as Record<string, unknown>).note).toContain('配对减');
  });

  it('M4-5 趋势保护拦截：手数对称大亏单超占比帽 → 不配对不平仓', async () => {
    function upCandles(): Candle[] {
      return Array.from({ length: 1200 }, (_, i) => {
        const c = 100_000 + i * 10;
        const prev = i > 0 ? 100_000 + (i - 1) * 10 : c;
        return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: c + 5, low: prev - 5, close: c, volume: 1 };
      });
    }
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams({ ...chain });
    s.onStart?.(params);
    const rec = makeExecutor();
    await s.onTick(
      makeContext(params, {
        candles: upCandles(),
        price: 111_990,
        netQty: 0,
        openLots: [
          oldLot({ direction: 'LONG', entryPrice: 110_000, quantity: 0.01, unrealizedPnl: 19.9 }),
          oldLot({ id: 'lot-s', direction: 'SHORT', entryPrice: 111_500, quantity: 0.01, unrealizedPnl: -4.9 }), // paired=0.01 > cap 0.003 → 拒
        ],
      }),
      rec.executor,
    );
    expect(rec.closes).toHaveLength(0);
    expect(rec.cancels).toHaveLength(0);
  });
});

describe('MartingaleGridV2Strategy · M5 pivot + M6 熔断开启态', () => {
  /** 1200 根线性下行（斜率 −100/根）：Brain 强空 + 3 根累计逆行 ≈ −0.29% */
  function downCandles(): Candle[] {
    return Array.from({ length: 1200 }, (_, i) => {
      const c = 130_000 - i * 100;
      const prev = i > 0 ? 130_000 - (i - 1) * 100 : c;
      return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: prev + 5, low: c - 5, close: c, volume: 1 };
    });
  }
  const v2Down = async (raw: Record<string, unknown>) => {
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams(raw);
    s.onStart?.(params);
    const rec = makeExecutor();
    await s.onTick(
      makeContext(params, {
        candles: downCandles(),
        price: 10_100,
        openLots: [makeLot({ quantity: 0.01, entryPrice: 40_000, unrealizedPnl: -300, openedAt: '2020-01-01T00:00:00Z' })],
      }),
      rec.executor,
    );
    return { s, rec };
  };
  const pbase = { useTrendFilter: true, useBrain: true, enabledSides: 'both', firstOrderMarket: false };

  it('M5 pivot：单侧深浮亏+逆行超阈 → 放行对侧 carry；关断态只守单边', async () => {
    const on = await v2Down({ ...pbase, usePivotCarry: true });
    const dirs = on.rec.stops.map((x) => x.direction);
    expect(dirs).toContain('SHORT'); // 浮亏 −300U < −max(50, 4700×5%) 且 3 根逆行 0.29% ≥ 0.25% → 双侧放行（行为即证据：对侧首层挂单）
    expect(on.rec.stops.some((x) => x.direction === 'SHORT' && x.stopPrice < 10_100)).toBe(true);
    const off = await v2Down({ ...pbase, usePivotCarry: false });
    expect(off.rec.stops.map((x) => x.direction)).not.toContain('SHORT'); // 单侧金字塔：持多不挂空
  });

  it('M6 ATR 尖峰：全场停开+note；关断态照挂', async () => {
    // 扁平 TR=100（high+50/low−50），末根 TR=1500 → cur=200 / med=100 = 2.0 → 尖峰
    const spike = Array.from({ length: 80 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 60_000,
      open: 100_000,
      high: i === 79 ? 101_000 : 100_050,
      low: i === 79 ? 99_500 : 99_950,
      close: 100_000,
      volume: 1,
    }));
    const run = async (on: boolean) => {
      const s = new MartingaleGridV2Strategy();
      const params = s.normalizeParams({
        useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false, useExtremeGuard: on,
      });
      s.onStart?.(params);
      const rec = makeExecutor();
      await s.onTick(makeContext(params, { candles: spike }), rec.executor);
      return { s, rec };
    };
    const onRes = await run(true);
    expect(onRes.rec.stops).toHaveLength(0);
    expect((onRes.s.getState() as Record<string, unknown>).note).toContain('熔断');
    const offRes = await run(false);
    expect(offRes.rec.stops).toHaveLength(1);
  });

  it('M6 量价方向门：末 20 根全阴跌 → 拦 LONG（SHORT 方向不受影响）', async () => {
    // 扁平/阴跌两段 TR 恒为 40（不触发尖峰）；实体 10 < 2×40（不触发大实体）
    const drift = Array.from({ length: 80 }, (_, i) => {
      if (i < 60) {
        return { time: 1_700_000_000_000 + i * 60_000, open: 100_000, high: 100_020, low: 99_980, close: 100_000, volume: 1 };
      }
      const o = 100_000 - (i - 59) * 10;
      const c = o - 10;
      return { time: 1_700_000_000_000 + i * 60_000, open: o, high: o + 15, low: c - 15, close: c, volume: 1 };
    });
    const run = async (on: boolean) => {
      const s = new MartingaleGridV2Strategy();
      const params = s.normalizeParams({
        useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false, useExtremeGuard: on,
      });
      s.onStart?.(params);
      const rec = makeExecutor();
      await s.onTick(makeContext(params, { candles: drift }), rec.executor);
      return rec;
    };
    expect((await run(true)).stops).toHaveLength(0);
    expect((await run(false)).stops).toHaveLength(1);
  });
});

describe('MartingaleGridV2Strategy · stateV:2 运行快照（M8-① 数据契约）', () => {
  const ord = (id: string, side: 'BUY' | 'SELL', stopPrice: number, quantity = 0.01) => ({
    id,
    side,
    type: 'STOP_MARKET',
    stopPrice,
    quantity,
    exchangeOrderId: `ex-${id}`,
  });
  const chain = {
    useTrendFilter: false,
    enabledSides: 'longOnly',
    firstOrderMarket: false,
    stepAtrMult: 3,
    minStepPct: 0.0001,
    maxStepPct: 0.03,
    useExitChain: true,
    triggerPriceType: 'last',
  };
  const oldLot = (o: Partial<StrategyLotView> = {}): StrategyLotView =>
    makeLot({ quantity: 0.01, entryPrice: 100_000, openedAt: '2020-01-01T00:00:00Z', ...o });
  const v2State = async (raw: Record<string, unknown>, steps: Partial<StrategyContext>[]) => {
    const s = new MartingaleGridV2Strategy();
    const params = s.normalizeParams(raw);
    s.onStart?.(params);
    const rec = makeExecutor();
    for (const st of steps) await s.onTick(makeContext(params, st), rec.executor);
    return { s, rec, state: s.getState() as Record<string, any> };
  };

  it('未跑过 tick：顶层只留 stateV/note/basketPeakPct 兜底（移动端零改动）', async () => {
    const s = new MartingaleGridV2Strategy();
    const st = s.getState() as Record<string, unknown>;
    expect(st.stateV).toBe(2);
    expect(typeof st.note).toBe('string');
    expect(st.basketPeakPct).toBe(0);
    expect(st.regime).toBeUndefined();
    expect(st.grid).toBeUndefined();
    expect(st.exits).toBeUndefined();
  });

  it('关断态 tick 后：regime=null 但 grid/exits/gates 结构完整，旧字段保留', async () => {
    const { state } = await v2State(
      { useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false },
      [{}],
    );
    expect(state.stateV).toBe(2);
    expect(state.price).toBe(100_000); // 旧顶层字段零改动（分流前的通用展示仍可用）
    expect(state.layers).toEqual({ long: 0, short: 0 });
    expect(state.regime).toBeNull();
    expect(state.grid.perSide.long.ladder).toBeInstanceOf(Array);
    expect(state.grid.perSide.long.stepNow).toBeGreaterThan(0);
    expect(state.grid.perSide.long.target).toBeNull(); // 链未开 → 侧目标不存
    expect(state.exits.basket.trailArmed).toBe(false);
    expect(state.exits.basket.retraceExitAt).toBeNull();
    expect(state.exits.pair.candidate).toBeNull();
    expect(state.gates).toEqual({ spike: false, funding: false, margin: false, atrRatio: null });
  });

  it('开启态：篮子 arm 后 trailArmed/retraceExitAt/peakPct 实时可见；frames 携六因子', async () => {
    const rich = oldLot({ unrealizedPnl: 25 }); // net=24.6 ≥ 18 → tick1 即 arm
    const { state } = await v2State({ ...chain, sideTargetPct: 0.05 }, [
      { openLots: [rich], openOrders: [ord('ord-v2', 'BUY', 100_400)], netQty: 0.01 },
    ]);
    expect(state.regime).toBeTruthy();
    expect(state.regime.frames).toHaveLength(3);
    expect(Object.keys(state.regime.frames[0].factors).sort()).toEqual([
      'di', 'donchian', 'ema', 'er', 'macd', 'slope',
    ]);
    expect(state.regime.calibrated).toEqual({ slopeNorm: 0.06, macdNorm: 0.3, diNorm: 40 });
    expect(state.exits.basket.trailArmed).toBe(true);
    expect(state.exits.basket.retraceExitAt).toBeCloseTo(100_000 * (1 - 0.008), 1);
    expect(state.exits.basket.peakPct).toBeGreaterThan(0);
    expect(state.exits.basket.startNow).toBeCloseTo(0.015, 6);
    expect(state.grid.perSide.long.layers).toBe(1);
    expect(state.grid.perSide.long.ladder[0].filled).toBe(true);
    expect(state.grid.perSide.long.pending[0].price).toBe(100_400);
    expect(state.grid.exposure.grossNotional).toBeCloseTo(1000, 2);
    expect(state.grid.exposure.marginOccupy).toBeCloseTo(100, 2); // 1000/10x
    expect(state.grid.exposure.guardRemainLayers).toBe(3); // 4帽−1层
  });

  it('配对候选预览：趋势域可配→allowed；防护拦→allowed=false 带 why', async () => {
    function upCandles(): Candle[] {
      return Array.from({ length: 1200 }, (_, i) => {
        const c = 100_000 + i * 10;
        const prev = i > 0 ? 100_000 + (i - 1) * 10 : c;
        return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: c + 5, low: prev - 5, close: c, volume: 1 };
      });
    }
    const base = {
      candles: upCandles(),
      price: 111_990,
      openLots: [oldLot({ direction: 'LONG', entryPrice: 110_000, quantity: 0.01, unrealizedPnl: 19.9 })],
    };
    const ok = await v2State({ ...chain, sideTargetPct: 0.006 }, [
      { ...base, netQty: 0.009, openLots: [...base.openLots, oldLot({ id: 'lot-s', direction: 'SHORT', entryPrice: 111_500, quantity: 0.001, unrealizedPnl: -0.49 })] },
    ]);
    expect(ok.state.exits.pair.candidate).toBeTruthy();
    expect(ok.state.exits.pair.candidate.allowed).toBe(true);
    expect(ok.state.exits.pair.candidate.profitLotId).toBe('lot-1');
    expect(ok.state.exits.pair.candidate.riskLotId).toBe('lot-s');
    const blocked = await v2State({ ...chain }, [
      { ...base, netQty: 0, openLots: [...base.openLots, oldLot({ id: 'lot-s', direction: 'SHORT', entryPrice: 111_500, quantity: 0.01, unrealizedPnl: -4.9 })] },
    ]);
    expect(blocked.state.exits.pair.candidate.allowed).toBe(false);
    expect(blocked.state.exits.pair.candidate.why).toContain('防护');
  });

  it('pivotAlarm 与熔断闸口：触发 tick 内如实置位', async () => {
    function downCandles(): Candle[] {
      return Array.from({ length: 1200 }, (_, i) => {
        const c = 130_000 - i * 100;
        const prev = i > 0 ? 130_000 - (i - 1) * 100 : c;
        return { time: 1_700_000_000_000 + i * 60_000, open: prev, high: prev + 5, low: c - 5, close: c, volume: 1 };
      });
    }
    const pbase = { useTrendFilter: true, useBrain: true, enabledSides: 'both', firstOrderMarket: false };
    const steps: Partial<StrategyContext>[] = [
      {
        candles: downCandles(),
        price: 10_100,
        openLots: [makeLot({ quantity: 0.01, entryPrice: 40_000, unrealizedPnl: -300, openedAt: '2020-01-01T00:00:00Z' })],
      },
    ];
    const on = await v2State({ ...pbase, usePivotCarry: true }, steps);
    expect(on.state.grid.exposure.pivotAlarm).toBe(true);
    const off = await v2State({ ...pbase, usePivotCarry: false }, steps);
    expect(off.state.grid.exposure.pivotAlarm).toBe(false);

    // 熔断尖峰 fixture（同 M6）：gates.spike 置位 + atrRatio 透出
    const spike = Array.from({ length: 80 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 60_000,
      open: 100_000,
      high: i === 79 ? 101_000 : 100_050,
      low: i === 79 ? 99_500 : 99_950,
      close: 100_000,
      volume: 1,
    }));
    const guarded = await v2State(
      { useTrendFilter: false, enabledSides: 'longOnly', firstOrderMarket: false, useExtremeGuard: true },
      [{ candles: spike }],
    );
    expect(guarded.state.gates.spike).toBe(true);
    expect(guarded.state.gates.atrRatio).toBeGreaterThanOrEqual(2);
  });
});
