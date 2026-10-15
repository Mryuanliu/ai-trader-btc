// king-v4-balance Brain 原语单测：每个断言都是手算 fixture，公式锚点见 core.ts 各函数注释
import { describe, it, expect } from 'vitest';
import {
  atrSimple,
  regressionSlopeAtr,
  efficiencyRatio,
  choppinessIndex,
  donchianBreakoutStrength,
  adxDi,
} from '../core';

describe('atrSimple（EA ManualAtr L1255）', () => {
  it('恒定波幅：TR=4 的 5 根 → 4', () => {
    const h = Array(6).fill(102);
    const l = Array(6).fill(98);
    const c = Array(6).fill(100);
    expect(atrSimple(h, l, c, 5)).toBeCloseTo(4, 10);
  });

  it('变动 TR 手算：(3+2)/2 = 2.5', () => {
    const h = [10, 12, 11];
    const l = [8, 10, 9];
    const c = [9, 11, 10];
    // 末两根：TR2=max(2,|12-9|,|10-9|)=3；TR3=max(2,|11-11|,|9-11|)=2
    expect(atrSimple(h, l, c, 2)).toBeCloseTo(2.5, 10);
  });

  it('数据不足返回 NaN（区别于 EA 回 0，调用方统一判 >0）', () => {
    expect(atrSimple([1, 2], [0, 1], [0.5, 1.5], 2)).toBeNaN();
  });
});

describe('regressionSlopeAtr（EA L1293）', () => {
  it('完美线性 1..5，atr=1 → slope=1、r2=1', () => {
    const r = regressionSlopeAtr([1, 2, 3, 4, 5], 5, 1);
    expect(r.slope).toBeCloseTo(1, 10);
    expect(r.r2).toBeCloseTo(1, 10);
  });

  it('斜率按 ATR 归一：atr=2 → 0.5', () => {
    expect(regressionSlopeAtr([1, 2, 3, 4, 5], 5, 2).slope).toBeCloseTo(0.5, 10);
  });

  it('下跌线性 → 负斜率', () => {
    expect(regressionSlopeAtr([5, 4, 3, 2, 1], 5, 1).slope).toBeCloseTo(-1, 10);
  });

  it('平坦序列 → slope=0、r2=0（corrDen=0 分支）', () => {
    const r = regressionSlopeAtr([3, 3, 3, 3, 3], 5, 1);
    expect(r.slope).toBe(0);
    expect(r.r2).toBe(0);
  });
});

describe('efficiencyRatio（EA L1278）', () => {
  it('单调上行 → er=1、signed=+1', () => {
    const r = efficiencyRatio([1, 2, 3, 4, 5], 4);
    expect(r.er).toBeCloseTo(1, 10);
    expect(r.signed).toBeCloseTo(1, 10);
  });

  it('单调下行 → signed=-1', () => {
    expect(efficiencyRatio([5, 4, 3, 2, 1], 4).signed).toBeCloseTo(-1, 10);
  });

  it('等幅锯齿净位移 0 → er=0', () => {
    expect(efficiencyRatio([0, 1, 0, 1, 0], 4).er).toBeCloseTo(0, 10);
  });

  it('半效率手算：位移 4 / 路程 8 = 0.5', () => {
    // closes: 0,4,0,4,4 → travel=4+4+0+0? 重新构造 0,2,0,2,4：travel=2+2+2+2=8，disp=4
    expect(efficiencyRatio([0, 2, 0, 2, 4], 4).er).toBeCloseTo(0.5, 10);
  });
});

describe('choppinessIndex（EA L1327）', () => {
  it('极限锯齿（trSum/range = 9）→ 100', () => {
    const n = 12;
    const h = Array(n).fill(101);
    const l = Array(n).fill(99);
    const c = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100 : 101));
    // TR 均为 2，period=9 → trSum=18，range=2 → 100·ln(9)/ln(9)=100
    expect(choppinessIndex(h, l, c, 9)).toBeCloseTo(100, 6);
  });

  it('平滑上行台阶 → 明显低抖动（<30）', () => {
    const n = 12;
    const h = Array.from({ length: n }, (_, i) => i + 1);
    const l = Array.from({ length: n }, (_, i) => i);
    const c = Array.from({ length: n }, (_, i) => i + 0.5);
    expect(choppinessIndex(h, l, c, 9)).toBeLessThan(30);
  });

  it('数据不足回 50（EA 同）', () => {
    expect(choppinessIndex([1, 2], [0, 1], [0.5, 1.5], 10)).toBe(50);
  });
});

describe('donchianBreakoutStrength（EA L1352，通道不含当根）', () => {
  // len=6, period=4 → 通道 = index 1..4
  const h = [96, 97, 98, 99, 100, 116];
  const l = [90, 90, 90, 90, 90, 90];
  const c = [95, 96, 97, 98, 99, 115];

  it('上破前高 15（1.5×ATR）→ clamp 到 +1', () => {
    expect(donchianBreakoutStrength(h, l, c, 4, 10)).toBeCloseTo(1, 10);
  });

  it('通道内收盘 → 0', () => {
    const c2 = [...c];
    c2[5] = 99;
    expect(donchianBreakoutStrength(h, l, c2, 4, 10)).toBe(0);
  });

  it('下破前低 10 → -1', () => {
    const c3 = [...c];
    c3[5] = 80;
    expect(donchianBreakoutStrength(h, l, c3, 4, 10)).toBeCloseTo(-1, 10);
  });
});

describe('adxDi（EA iADX 缓冲 1/2）', () => {
  it('稳定上行 → plusDI≈66.7、minusDI=0', () => {
    const n = 40;
    const h = Array.from({ length: n }, (_, i) => i + 1);
    const l = Array.from({ length: n }, (_, i) => i);
    const c = Array.from({ length: n }, (_, i) => i + 0.5);
    // 每根：+DM=1（up=1>down=-1）、-DM=0、TR=1.5 → DI+ = 100×14/21
    const r = adxDi(h, l, c, 14);
    expect(r.plusDI).toBeCloseTo(100 / 1.5, 6);
    expect(r.minusDI).toBe(0);
  });

  it('稳定下行 → minusDI 占优', () => {
    const n = 40;
    const h = Array.from({ length: n }, (_, i) => -i + 1);
    const l = Array.from({ length: n }, (_, i) => -i);
    const c = Array.from({ length: n }, (_, i) => -i + 0.5);
    const r = adxDi(h, l, c, 14);
    expect(r.minusDI).toBeCloseTo(100 / 1.5, 6);
    expect(r.plusDI).toBe(0);
  });

  it('数据不足回 NaN', () => {
    const r = adxDi([1, 2, 3], [0, 1, 2], [0.5, 1.5, 2.5], 14);
    expect(r.plusDI).toBeNaN();
  });
});
