import { describe, expect, it } from 'vitest';
import { checkSpotMinQty, computeSpotOrderQty } from '../market-executor';
import { FALLBACK_SYMBOL_FILTERS } from '../common';
import type { SymbolFilters } from '../common';

const filters: SymbolFilters = {
  symbol: 'BTCUSDT',
  stepSize: 0.00001,
  tickSize: 0.01,
  minQty: 0.00001,
  maxQty: 9_000_000,
  minNotional: 5,
};

describe('computeSpotOrderQty 现货数量公式', () => {
  const base = {
    quoteFree: 10_000,
    baseFree: 0.05,
    positionPct: 0.1,
    price: 78_000,
  };

  it('买入 = 可用USDT × positionPct ÷ 价格', () => {
    // 10000 × 0.1 / 78000 = 0.01282051282051282…
    const qty = computeSpotOrderQty({ ...base, action: 'BUY' });
    expect(qty).toBeCloseTo(0.0128205128, 9);
  });

  it('买入受仓位乘数影响，且钳制在 0.5~1.5', () => {
    const plain = computeSpotOrderQty({ ...base, action: 'BUY' });
    const doubled = computeSpotOrderQty({ ...base, action: 'BUY', positionMultiplier: 2 });
    const halved = computeSpotOrderQty({ ...base, action: 'BUY', positionMultiplier: 0 });
    // 2 被钳到 1.5，0 被钳到 0.5
    expect(doubled).toBeCloseTo(plain * 1.5, 10);
    expect(halved).toBeCloseTo(plain * 0.5, 10);
  });

  it('买入时乘数为 null/undefined 等价于 1', () => {
    const plain = computeSpotOrderQty({ ...base, action: 'BUY' });
    expect(computeSpotOrderQty({ ...base, action: 'BUY', positionMultiplier: null })).toBe(plain);
    expect(
      computeSpotOrderQty({ ...base, action: 'BUY', positionMultiplier: undefined }),
    ).toBe(plain);
  });

  it('卖出按 positionPct 部分卖，closeAll 时全卖', () => {
    expect(computeSpotOrderQty({ ...base, action: 'SELL' })).toBeCloseTo(0.005, 10);
    expect(computeSpotOrderQty({ ...base, action: 'SELL', closeAll: true })).toBe(0.05);
  });

  it('卖出不受仓位乘数影响（乘数只放大开仓，不放大平仓）', () => {
    const plain = computeSpotOrderQty({ ...base, action: 'SELL' });
    const withMultiplier = computeSpotOrderQty({ ...base, action: 'SELL', positionMultiplier: 1.5 });
    expect(withMultiplier).toBe(plain);
  });

  it('HOLD 恒为 0；价格非法时买入为 0', () => {
    expect(computeSpotOrderQty({ ...base, action: 'HOLD' })).toBe(0);
    expect(computeSpotOrderQty({ ...base, action: 'BUY', price: 0 })).toBe(0);
  });
});

describe('computeSpotOrderQty 与改造前行内公式等价（回归断言）', () => {
  /**
   * AgentEngine 改造前的行内实现，原样保留在此作为对照基准。
   * 一旦两者出现任何差异，说明抽取过程中改坏了现货下单口径。
   */
  function legacyInlineQty(p: {
    action: 'BUY' | 'SELL';
    quoteFree: number;
    baseFree: number;
    positionPct: number;
    price: number;
    positionMultiplier?: number | null;
    closeAll?: boolean;
  }): number {
    const side = p.action === 'BUY' ? 'BUY' : 'SELL';
    const buyMultiplier =
      p.action === 'BUY' && p.positionMultiplier != null
        ? Math.min(1.5, Math.max(0.5, p.positionMultiplier))
        : 1;
    return side === 'BUY'
      ? (p.quoteFree * p.positionPct * buyMultiplier) / p.price
      : p.closeAll
        ? p.baseFree
        : p.baseFree * p.positionPct;
  }

  const quoteFrees = [0, 1, 100, 4984.478574, 10_000, 1_000_000];
  const baseFrees = [0, 0.0001998, 0.05, 1.23456789];
  const positionPcts = [0.0001, 0.01, 0.1, 0.5, 1];
  const prices = [1, 78052.9, 78_000, 123_456.78];
  const multipliers: (number | null | undefined)[] = [null, undefined, 0, 0.25, 0.5, 1, 1.2, 1.5, 3];

  it('全组合下与改造前行内公式逐位一致', () => {
    for (const action of ['BUY', 'SELL'] as const) {
      for (const quoteFree of quoteFrees) {
        for (const baseFree of baseFrees) {
          for (const positionPct of positionPcts) {
            for (const price of prices) {
              for (const positionMultiplier of multipliers) {
                for (const closeAll of [true, false]) {
                  const input = {
                    action,
                    quoteFree,
                    baseFree,
                    positionPct,
                    price,
                    positionMultiplier,
                    closeAll,
                  };
                  const legacy = legacyInlineQty(input);
                  const extracted = computeSpotOrderQty(input);
                  expect(extracted, JSON.stringify(input)).toBe(legacy);
                }
              }
            }
          }
        }
      }
    }
  });

  it('HOLD 在改造前不会走到该分支，抽取后恒为 0', () => {
    // AgentEngine 在进入数量计算前已用 if (action === 'HOLD') return null 拦截，
    // 故 HOLD 取 0 不会改变任何既有行为。
    expect(
      computeSpotOrderQty({
        action: 'HOLD',
        quoteFree: 1000,
        baseFree: 1,
        positionPct: 0.1,
        price: 100,
      }),
    ).toBe(0);
  });
});

describe('checkSpotMinQty 最小下单量校验', () => {
  it('数量足够时通过，返回取整后的值', () => {
    const r = checkSpotMinQty(0.0128205, filters);
    expect(r.ok).toBe(true);
    // 按 stepSize 0.00001 向下取整
    expect(r.quantity).toBeCloseTo(0.01282, 10);
  });

  it('取整后为 0 时拒绝', () => {
    const r = checkSpotMinQty(0.000001, filters);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('不足最小下单单位');
  });

  it('低于最小数量时拒绝', () => {
    const r = checkSpotMinQty(0.000005, { ...filters, minQty: 0.001 });
    expect(r.ok).toBe(false);
  });

  it('消除浮点噪声，且绝不向上舍入（超出可用余额是更危险的错）', () => {
    // 裸 Math.floor 会留下二进制噪声：0.03/0.0001 -> 0.030000000000000002
    const q = 0.03;
    const step = 0.0001;
    const naive = Math.floor(q / step) * step;
    const checked = checkSpotMinQty(q, { ...filters, stepSize: step, minQty: step });

    expect(naive).toBe(0.030000000000000002); // 噪声确实存在
    expect(checked.quantity).toBe(0.03); // 取整结果干净
    expect(checked.quantity).toBeLessThanOrEqual(q); // 关键：不向上舍入
  });

  it('过滤器缺失时回落到兜底值而不是崩掉', () => {
    const r = checkSpotMinQty(0.5, {
      symbol: 'BTCUSDT',
      stepSize: 0,
      tickSize: 0,
      minQty: 0,
      maxQty: 0,
      minNotional: FALLBACK_SYMBOL_FILTERS.minNotional,
    });
    expect(r.ok).toBe(true);
  });
});
