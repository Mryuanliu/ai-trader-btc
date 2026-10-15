// M6 三层熔断纯函数层：尖峰/量价门/大实体各向断言
import { describe, expect, it } from 'vitest';
import type { Candle } from '@ai-trader/shared';
import { extremeGuardFlags } from '../extreme-guard';

const cfg = { atrSpikeMult: 2.0, volDirGate: 0.3, bodyAtrMult: 2.0 };

/** 80 根扁平市：TR=100（high+50/low−50），close 恒定 → 无向门/实体触发 */
function flatCandles(price = 100_000, count = 80): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: price,
    high: price + 50,
    low: price - 50,
    close: price,
    volume: 1,
  }));
}

describe('extremeGuardFlags · 冷启动放行', () => {
  it('数据不足（<17 根）→ 全 false（无证据不拦截）', () => {
    const g = extremeGuardFlags(flatCandles(100_000, 10), cfg);
    expect(g.spike).toBe(false);
    expect(g.blockLong).toBe(false);
    expect(g.blockShort).toBe(false);
    expect(g.atrRatio).toBe(1);
  });

  it('扁平市常态 → 无尖峰无拦截', () => {
    const g = extremeGuardFlags(flatCandles(), cfg);
    expect(g.spike).toBe(false);
    expect(g.atrRatio).toBeCloseTo(1, 6);
    expect(g.blockLong).toBe(false);
    expect(g.blockShort).toBe(false);
  });
});

describe('extremeGuardFlags · 第 1 层 ATR 尖峰', () => {
  it('末根 TR=1500：cur=(13×100+1500)/14=200 → ratio=2.0 ≥ 2 → 双向停开', () => {
    const cs = flatCandles();
    cs[cs.length - 1] = { ...cs[cs.length - 1], high: 101_000, low: 99_500 };
    const g = extremeGuardFlags(cs, cfg);
    expect(g.atrRatio).toBeCloseTo(2.0, 6);
    expect(g.spike).toBe(true);
    expect(g.blockLong).toBe(true);
    expect(g.blockShort).toBe(true);
  });
  it('未达倍数（ratio<2）→ 放行', () => {
    const cs = flatCandles();
    cs[cs.length - 1] = { ...cs[cs.length - 1], high: 100_800, low: 99_600 }; // TR=1200 → cur≈164 → ratio 1.64
    const g = extremeGuardFlags(cs, cfg);
    expect(g.spike).toBe(false);
  });
});

describe('extremeGuardFlags · 第 2 层 量价方向门', () => {
  /** 前 60 根扁平 + 末 20 根匀速阴跌（TR 平稳无尖峰、实体小） */
  function downDrift(): Candle[] {
    const cs = flatCandles(100_000, 80);
    for (let i = 60; i < 80; i++) {
      const o = 100_000 - (i - 60) * 10;
      cs[i] = { time: cs[i].time, open: o, high: o + 2, low: o - 12, close: o - 10, volume: 1 };
    }
    return cs;
  }
  it('近 20 根全阴跌 → upShare=0 < 0.30 拦 LONG，SHORT 不拦', () => {
    const g = extremeGuardFlags(downDrift(), cfg);
    expect(g.spike).toBe(false);
    expect(g.upShare).toBeCloseTo(0, 10);
    expect(g.blockLong).toBe(true);
    expect(g.blockShort).toBe(false);
  });
  it('镜像阳升 → 拦 SHORT 不拦 LONG', () => {
    const up = flatCandles(100_000, 80);
    for (let i = 60; i < 80; i++) {
      const c = 100_000 + (i - 60) * 10; // 收盘逐根抬升 → 全部上涨量
      up[i] = { time: up[i].time, open: c - 10, high: c + 2, low: c - 12, close: c, volume: 1 };
    }
    const g = extremeGuardFlags(up, cfg);
    expect(g.downShare).toBeCloseTo(0, 10); // i=60 与前收持平不计，其余全涨
    expect(g.blockShort).toBe(true);
    expect(g.blockLong).toBe(false);
  });
});

describe('extremeGuardFlags · 第 3 层 大实体拦截', () => {
  it('末根阴线实体 1000U ≥ 2×ATR(164) → 拦 LONG；关向门以隔离本层', () => {
    const cs = flatCandles();
    cs[cs.length - 1] = { ...cs[cs.length - 1], open: 100_000, close: 99_000, high: 100_000, low: 99_000 };
    const off = { ...cfg, volDirGate: 0 };
    const g = extremeGuardFlags(cs, off);
    expect(g.spike).toBe(false); // cur≈164 / med 100 = 1.64 < 2
    expect(g.blockLong).toBe(true); // 大阴线拦多头
    expect(g.blockShort).toBe(false);
  });
  it('末根阳线同规格 → 拦 SHORT', () => {
    const cs = flatCandles();
    cs[cs.length - 1] = { ...cs[cs.length - 1], open: 99_000, close: 100_000, high: 100_000, low: 99_000 };
    const g = extremeGuardFlags(cs, { ...cfg, volDirGate: 0 });
    expect(g.blockShort).toBe(true);
    expect(g.blockLong).toBe(false);
  });
});
