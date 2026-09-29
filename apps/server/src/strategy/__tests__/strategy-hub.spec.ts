import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import { StrategyHub } from '../strategy-hub.service';
import type { StrategyRegistry } from '../strategy-registry.service';
import type { BacktestService, GateVerdict } from '../../backtest/backtest.service';
import type { StrategyDescriptor } from '@ai-trader/shared';

function impl(name: string): StrategyDescriptor {
  return {
    name,
    label: `代码内-${name}`,
    description: '代码内的描述',
    defaultParams: { fromCode: true },
    paramSchema: { fromCode: true },
  };
}

/** 用「有哪些实现」构造 registry 的替身 */
function registryWith(names: string[]): StrategyRegistry {
  const map = new Map(names.map((n) => [n, impl(n)]));
  return {
    get: (n: string) => map.get(n),
    list: () => [...map.values()],
  } as unknown as StrategyRegistry;
}

/** 闸门 mock：默认全部通过 */
function mockBacktest(verdict?: Partial<GateVerdict>): BacktestService {
  return {
    hasPassingResearch: async () => ({
      passed: true,
      reasons: [],
      dsr: 0.7,
      oosSharpe: 1.2,
      oosMaxDD: 3,
      runId: 'mock',
      ...verdict,
    }),
  } as unknown as BacktestService;
}

describe('StrategyHub 策略包上下架', () => {
  it('能扫描到磁盘上的策略包清单', async () => {
    const hub = new StrategyHub(registryWith(['martingale_grid', 'trend_following']), mockBacktest());
    const r = await hub.load();

    // 两个包都有 manifest.json
    expect(r.found).toBeGreaterThanOrEqual(2);
    const names = hub.loadedManifests().map((m) => m.name);
    expect(names).toContain('martingale_grid');
    expect(names).toContain('trend_following');
  });

  it('清单里的展示文案与默认参数覆盖代码值（改文案不必改代码）', async () => {
    const hub = new StrategyHub(registryWith(['martingale_grid']), mockBacktest());
    await hub.load();

    const s = hub.list().find((x) => x.name === 'martingale_grid');
    expect(s).toBeDefined();
    // 代码里是「代码内-martingale_grid」，清单里是「马丁网格」
    expect(s!.label).toBe('马丁网格');
    expect(s!.defaultParams).toHaveProperty('basketStartPct');
  });

  it('有清单但缺实现的策略不上架，并在加载结果里点名', async () => {
    // 磁盘上有 trend_following 的清单，但这里不提供实现
    const hub = new StrategyHub(registryWith(['martingale_grid']), mockBacktest());
    const r = await hub.load();

    expect(r.missingImpl).toContain('trend_following');
    expect(hub.list().map((s) => s.name)).not.toContain('trend_following');
  });

  it('没有清单的策略一律不上架（缺版本与风险提示不允许进市场）', async () => {
    const hub = new StrategyHub(registryWith(['some_undeclared_strategy']), mockBacktest());
    await hub.load();
    expect(hub.list()).toHaveLength(0);
  });

  it('isAvailable 反映「已上架且实现存在」', async () => {
    const hub = new StrategyHub(registryWith(['martingale_grid']), mockBacktest());
    await hub.load();
    expect(hub.isAvailable('martingale_grid')).toBe(true);
    expect(hub.isAvailable('trend_following')).toBe(false);
  });

  it('下架后从市场消失，重新上架后回来（写回 manifest.json）', async () => {
    const hub = new StrategyHub(registryWith(['martingale_grid']), mockBacktest());
    await hub.load();
    expect(hub.isAvailable('martingale_grid')).toBe(true);

    const off = await hub.setEnabled('martingale_grid', false);
    if (!off.ok) console.error('下架失败原因:', off.message);
    expect(off.ok).toBe(true);
    expect(hub.isAvailable('martingale_grid')).toBe(false);

    // 还原，避免影响后续真实运行
    const on = await hub.setEnabled('martingale_grid', true);
    expect(on.ok).toBe(true);
    expect(hub.isAvailable('martingale_grid')).toBe(true);
  });

  // 注：不测「策略目录不存在」的分支——那需要 chdir，
  // 而 chdir 是**进程级全局状态**，在并发执行时会污染其他用例。
  // 该分支由 load() 里的 try/catch 保证（读不到目录就当作没有策略包）。
});

describe('StrategyHub 闸门拒绝上架', () => {
  it('闸门未达且无 forceOverride → 拒绝', async () => {
    const hub = new StrategyHub(
      registryWith(['donchian_breakout']),
      mockBacktest({ passed: false, reasons: ['sweep DSR=0.3 < 0.5'] }),
    );
    await hub.load();
    const r = await hub.setEnabled('donchian_breakout', true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('闸门未达');
    expect(r.gate?.passed).toBe(false);
  });

  it('闸门未达但带 forceOverride → 允许并留痕', async () => {
    const hub = new StrategyHub(
      registryWith(['donchian_breakout']),
      mockBacktest({ passed: false, reasons: ['无 30 天内 sweep 运行'], dsr: 0.2 }),
    );
    await hub.load();
    const r = await hub.setEnabled('donchian_breakout', true, {
      forceOverride: { reason: '内部测试用途，强制上架' },
    });
    expect(r.ok).toBe(true);
    // 检查 manifest 写入了 backtestRef
    const m = hub.loadedManifests().find((x) => x.name === 'donchian_breakout');
    expect(m?.backtestRef).toBeDefined();
    expect(m?.backtestRef?.verdict).toBe('overfit');
    expect(m?.backtestRef?.overrideReason).toContain('强制上架');
    // 还原（下架并清理）
    await hub.setEnabled('donchian_breakout', false);
  });
});
