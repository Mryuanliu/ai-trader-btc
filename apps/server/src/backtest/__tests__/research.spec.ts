import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BacktestConfig, Candle } from '@ai-trader/shared';
import type { StrategyContext, StrategyExecutor, TradingStrategy } from '../../strategy/types';
import { STRATEGY_REGISTRY } from '../strategy-registry';
import { cpcv } from '../research/cpcv';
import {
  deflatedSharpe,
  expectedMaxSharpe,
} from '../research/deflated-sharpe';
import { lookaheadCheck } from '../research/lookahead-check';
import { normalCdf, normInv } from '../research/stats';
import { runSweep } from '../research/sweep';
import { walkForward } from '../research/walk-forward';

function genCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = Math.sin(i / 15) * 0.8;
    const open = price;
    const close = Math.max(1, open + drift + ((i % 7) - 3) * 0.2);
    out.push({
      time: i * 300_000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: 1,
    });
    price = close;
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'bt-research-'));
const file = join(dir, 'candles.json');
const candles = genCandles(700);
writeFileSync(file, JSON.stringify({ symbol: 'BTCUSDT', interval: '5m', candles }));

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'BTCUSDT',
    interval: '5m',
    initialCapital: 10_000,
    warmupBars: 50,
    feeRateBps: 4,
    slippageBps: 10,
    fundingPctPer8h: 0,
    strategyName: 'trend_following',
    params: { baseQty: 1, cooldownSec: 0 },
    file,
    ...overrides,
  };
}

describe('Deflated Sharpe（纯数学）', () => {
  it('normInv 是 normalCdf 的逆', () => {
    for (const z of [-2, -0.5, 0, 0.7, 2.3]) {
      expect(normInv(normalCdf(z))).toBeCloseTo(z, 3);
    }
  });

  it('期望最大夏普随试验数单调上升（同方差 ±1 构造，std 近似恒定）', () => {
    // 用对称 ±1 序列，让不同 N 组的 std 近似（√(N/(N-1))→1），只考察 N 的单调效应
    const make = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const a = expectedMaxSharpe(make(2));
    const b = expectedMaxSharpe(make(10));
    const c = expectedMaxSharpe(make(100));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('高夏普 + 长样本 + 少试验 → 通过；低夏普 → 不通过', () => {
    const goodReturns = Array.from({ length: 400 }, (_, i) => 0.001 + Math.sin(i) * 0.0005);
    const good = deflatedSharpe({
      obsSharpe: 0.15,
      trialSharpes: [0.14, 0.15],
      obsReturns: goodReturns,
    });
    expect(good.dsr).toBeGreaterThan(0.95);
    expect(good.passed).toBe(true);

    const mehReturns = Array.from({ length: 400 }, (_, i) => Math.sin(i) * 0.01);
    const meh = deflatedSharpe({
      obsSharpe: 0.001,
      trialSharpes: [0.001, 0.0009, 0.0011],
      obsReturns: mehReturns,
    });
    expect(meh.passed).toBe(false);
  });
});

describe('walk-forward', () => {
  it('切出多窗且拼接 OOS 净值长度>0、指标有限', async () => {
    const wf = await walkForward('trend_following', baseConfig(), candles, {
      trainBars: 120,
      testBars: 60,
    });
    expect(wf.segments.length).toBeGreaterThanOrEqual(3);
    // 无未来泄漏：每段 test 严格晚于自身 train；且滚动不回头
    for (const s of wf.segments) {
      expect(s.testFrom).toBeGreaterThan(s.trainTo);
      expect(s.trainTo).toBeGreaterThan(s.trainFrom);
    }
    for (let i = 1; i < wf.segments.length; i += 1) {
      expect(wf.segments[i].trainFrom).toBeGreaterThanOrEqual(wf.segments[i - 1].trainFrom);
    }
    expect(wf.oosEquity.length).toBeGreaterThan(0);
    expect(Number.isFinite(wf.aggregateOosSharpe)).toBe(true);
    expect(Number.isFinite(wf.aggregateIsSharpe)).toBe(true);
  });

  it('数据不足时抛错', async () => {
    await expect(
      walkForward('trend_following', baseConfig(), candles.slice(0, 60), {
        trainBars: 120,
        testBars: 60,
      }),
    ).rejects.toThrow();
  });
});

describe('CPCV', () => {
  it('输出夏普分布且 nCombos=C(5,1)', async () => {
    const res = await cpcv('trend_following', baseConfig(), candles, { nFoldK: 5, testFoldSize: 1 });
    expect(res.nCombos).toBe(5);
    expect(res.oosSharpes.length).toBeGreaterThanOrEqual(1);
    expect(res.quantiles).toHaveLength(5);
    expect(res.mean).toBeLessThanOrEqual(res.max);
  });
});

describe('参数扫描', () => {
  it('笛卡尔积组合数正确、bestIndex 有效、逐组合带 DSR', async () => {
    const res = await runSweep('trend_following', baseConfig(), candles, {
      atrPeriod: [10, 14],
      stopAtrMult: [1.5, 2],
    });
    expect(res.combos).toBe(4);
    expect(res.cells).toHaveLength(4);
    expect(res.bestIndex).toBeGreaterThanOrEqual(0);
    expect(res.bestIndex).toBeLessThan(4);
    expect(res.cells.every((c) => c.dsr !== undefined)).toBe(true);
  });

  it('超过组合上限时抛错', async () => {
    const big: Record<string, number[]> = { a: [], b: [] };
    for (let i = 0; i < 23; i += 1) {
      big.a.push(i);
      big.b.push(i);
    }
    await expect(runSweep('trend_following', baseConfig(), candles, big)).rejects.toThrow(/上限/);
  });
});

describe('lookahead 自检', () => {
  it('对已修复墙钟的 trend_following 判定干净', async () => {
    const res = await lookaheadCheck('trend_following', baseConfig(), candles);
    expect(res.ok).toBe(true);
    expect(res.messages).toHaveLength(0);
  });

  it('对使用随机数的非纯策略报警', async () => {
    class RandomStrategy implements TradingStrategy {
      readonly name = '__random_bad';
      readonly label = 'bad';
      readonly description = 'uses Math.random to break determinism';
      readonly defaultParams = {};
      readonly paramSchema = {};
      normalizeParams(): Record<string, unknown> {
        return {};
      }
      async onTick(_ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
        if (Math.random() > 0.5) {
          await exec.openLot({ direction: 'LONG', quantity: 1, reason: 'rand' });
        }
      }
      getState(): Record<string, unknown> {
        return {};
      }
    }
    STRATEGY_REGISTRY.__random_bad = () => new RandomStrategy();
    try {
      const res = await lookaheadCheck('__random_bad', baseConfig(), candles);
      expect(res.ok).toBe(false);
      expect(res.messages.some((m) => /确定性|随机/.test(m))).toBe(true);
    } finally {
      delete STRATEGY_REGISTRY.__random_bad;
    }
  });
});
