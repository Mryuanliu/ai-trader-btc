import { describe, expect, it } from 'vitest';
import {
  analyzeSignal,
  defaultLag,
  forwardReturns,
  hacStdError,
  isNonDecreasing,
  mean,
  pearson,
  quantileReturns,
  rank,
  rollingIcSeries,
  spearman,
  std,
} from '../ic';

/**
 * 统计函数的正确性直接决定 C 期结论是否可信——
 * 若 Spearman 或 HAC 算错，后面所有"信号有没有用"的判断都是空中楼阁。
 * 因此这里用**已知答案的构造数据**逐一验证。
 */

describe('基础统计', () => {
  it('mean / std 与手算一致', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    // 样本标准差（n-1）：[1,2,3,4] 的 std
    expect(std([1, 2, 3, 4])).toBeCloseTo(1.29099, 4);
    expect(std([5])).toBe(0); // 单点无标准差
    expect(std([])).toBe(0);
  });

  it('pearson：完全正相关=1、完全负相关=-1、无关=0', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
    expect(pearson([1, 2, 3, 4], [1, 3, 2, 4])).toBeCloseTo(0.8, 6);
    expect(pearson([], [])).toBe(0);
    expect(pearson([1], [1])).toBe(0); // 单点无相关
  });

  it('pearson：常数序列分母为 0，安全返回 0（不除零）', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
});

describe('rank（并列值取平均排名）', () => {
  it('无并列时排名即顺序', () => {
    expect(rank([10, 30, 20])).toEqual([1, 3, 2]);
  });

  it('并列值共享平均排名', () => {
    // [10, 20, 20, 30] → 排名 [1, 2.5, 2.5, 4]
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('全部相同时排名全为 (n+1)/2', () => {
    // 信号是离散三档，必然大量并列——这个场景必须正确
    expect(rank([5, 5, 5])).toEqual([2, 2, 2]);
  });

  it('三档信号（多/空/中立）排名正确', () => {
    // -1(空) 2 个、0(中立) 2 个、+1(多) 2 个
    // 排名：-1→1.5, 0→3.5, +1→5.5
    expect(rank([1, -1, 0, 1, -1, 0])).toEqual([5.5, 1.5, 3.5, 5.5, 1.5, 3.5]);
  });

  it('空数组与单元素不崩溃', () => {
    expect(rank([])).toEqual([]);
    expect(rank([7])).toEqual([1]);
  });
});

describe('spearman（秩相关）', () => {
  it('单调序列：完全相关', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });

  it('对非线性单调变换不变（这是秩相关的核心优势）', () => {
    // Pearson 会被非线性削弱，Spearman 不受影响
    const x = [1, 2, 3, 4, 5];
    const yExp = [1, 4, 9, 16, 25]; // y = x^2，严格单调
    expect(spearman(x, yExp)).toBeCloseTo(1, 6);
  });

  it('离散三档信号可用（信号实际就是离散的）', () => {
    const sig = [1, 1, 0, -1, -1];
    const ret = [0.05, 0.04, 0.01, -0.03, -0.04];
    const ic = spearman(sig, ret);
    expect(ic).toBeGreaterThan(0.9); // 强正相关
  });

  it('常数序列返回 0（信号长期无变化时安全）', () => {
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
});

describe('HAC（Newey-West）标准误', () => {
  it('无自相关时，HAC 标准误接近普通标准误', () => {
    // 白噪声序列：自相关≈0，HAC 应与 std/sqrt(n) 接近
    const xs = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.015, -0.005];
    const n = xs.length;
    const m = mean(xs);
    const centered = xs.map((v) => v - m);
    const hacSe = hacStdError(centered, 3);
    const naiveSe = std(xs) / Math.sqrt(n);
    // 允许一定偏差（小样本下 Bartlett 核权重影响较大）
    expect(hacSe).toBeGreaterThan(0);
    expect(hacSe).toBeLessThan(naiveSe * 2.5);
  });

  it('强正自相关时，HAC 标准误显著大于普通标准误（修正虚高 t 值）', () => {
    // 构造 AR(1) 强自相关序列
    const n = 200;
    const e: number[] = [];
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * 2 - 1;
    };
    let prev = rnd();
    for (let i = 0; i < n; i += 1) {
      prev = 0.9 * prev + 0.1 * rnd(); // rho=0.9 强自相关
      e.push(prev);
    }
    const m = mean(e);
    const centered = e.map((v) => v - m);
    const hacSe = hacStdError(centered, 10);
    const naiveSe = std(e) / Math.sqrt(n);
    // HAC 应明显放大标准误——这正是修正 t 值虚高的机制
    expect(hacSe).toBeGreaterThan(naiveSe);
  });

  it('空序列与单点安全返回 0', () => {
    expect(hacStdError([], 5)).toBe(0);
    expect(hacStdError([0.5], 5)).toBe(0);
  });

  it('滞后阶数超过样本量时被夹紧（不越界）', () => {
    const xs = [1, 2, 3];
    expect(() => hacStdError(xs, 100)).not.toThrow();
    expect(hacStdError(xs, 100)).toBeGreaterThanOrEqual(0);
  });

  it('defaultLag 随样本量增长且不小于 1', () => {
    expect(defaultLag(10)).toBeGreaterThanOrEqual(1);
    expect(defaultLag(1000)).toBeGreaterThanOrEqual(1);
    expect(defaultLag(10000)).toBeGreaterThan(defaultLag(100));
  });
});

describe('分位收益', () => {
  it('按信号从小到大分 5 档，返回各档平均收益', () => {
    const sig = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ret = sig.map((v) => v * 0.01); // 收益与信号严格正相关
    const qs = quantileReturns(sig, ret, 5);
    expect(qs).toHaveLength(5);
    // 严格递增
    for (let i = 1; i < qs.length; i += 1) expect(qs[i]).toBeGreaterThan(qs[i - 1]);
  });

  it('样本数不能被档数整除时，余数均摊且总数精确', () => {
    // 11 个样本分 5 档：前三档 3 个、后两档 1 个... 实际为 3,3,2,2,1 的均摊
    const sig = Array.from({ length: 11 }, (_, i) => i);
    const ret = sig.map(() => 1);
    const qs = quantileReturns(sig, ret, 5);
    expect(qs).toHaveLength(5);
    // 每档均值都应为 1（收益全相同）
    for (const q of qs) expect(q).toBeCloseTo(1, 6);
  });

  it('空数据与档数大于样本数时不崩溃', () => {
    expect(quantileReturns([], [], 5)).toHaveLength(5);
    expect(quantileReturns([1, 2], [1, 2], 5)).toHaveLength(5);
  });
});

describe('单调性判定', () => {
  it('单调不减为 true（允许相等）', () => {
    expect(isNonDecreasing([1, 2, 2, 3])).toBe(true);
    expect(isNonDecreasing([1, 1, 1])).toBe(true);
  });

  it('出现下降即为 false', () => {
    expect(isNonDecreasing([1, 3, 2])).toBe(false);
  });

  it('空与单元素为 true', () => {
    expect(isNonDecreasing([])).toBe(true);
    expect(isNonDecreasing([1])).toBe(true);
  });
});

describe('未来收益', () => {
  it('简单收益率计算正确', () => {
    const closes = [100, 101, 103, 102, 105];
    const fr = forwardReturns(closes, 1);
    expect(fr[0]).toBeCloseTo(0.01, 6); // (101-100)/100
    expect(fr[1]).toBeCloseTo(0.019802, 5); // (103-101)/101
    expect(fr[2]).toBeCloseTo(-0.009709, 5); // (102-103)/103
  });

  it('多周期 horizon 正确', () => {
    const closes = [100, 101, 102, 103];
    const fr = forwardReturns(closes, 2);
    expect(fr[0]).toBeCloseTo(0.02, 6); // (102-100)/100
    expect(fr[1]).toBeCloseTo(0.019802, 5); // (103-101)/101
  });

  it('末尾不足 horizon 的位置为 NaN（不可预知未来）', () => {
    const closes = [100, 101, 102];
    const fr = forwardReturns(closes, 2);
    expect(Number.isNaN(fr[1])).toBe(true);
    expect(Number.isNaN(fr[2])).toBe(true);
  });

  it('对数收益模式', () => {
    const closes = [100, 110];
    const fr = forwardReturns(closes, 1, 'log');
    expect(fr[0]).toBeCloseTo(Math.log(1.1), 6);
  });

  it('非正价格被跳过（避免除零/负价格）', () => {
    const fr = forwardReturns([100, 0, 50], 1);
    expect(Number.isNaN(fr[0])).toBe(true);
  });
});

describe('滚动 IC 序列', () => {
  it('窗口内信号与收益相关时产出高 IC', () => {
    const n = 300;
    const sig = Array.from({ length: n }, (_, i) => (i % 10) - 5);
    const ret = sig.map((v) => v * 0.01); // 完全正相关
    const ics = rollingIcSeries(sig, ret, 100, 10);
    expect(ics.length).toBeGreaterThan(0);
    // 每个窗口的 IC 都应接近 1
    for (const ic of ics) expect(ic).toBeGreaterThan(0.9);
  });

  it('窗口内信号恒定（无方差）时跳过该窗口', () => {
    const sig = new Array(250).fill(1); // 全部相同
    const ret = Array.from({ length: 250 }, (_, i) => i * 0.001);
    const ics = rollingIcSeries(sig, ret, 100, 10);
    expect(ics).toHaveLength(0);
  });

  it('样本量小于窗口时返回空（不产生伪造结果）', () => {
    const ics = rollingIcSeries([1, 2, 3], [1, 2, 3], 100);
    expect(ics).toHaveLength(0);
  });

  it('step 参数控制采样密度', () => {
    const n = 400;
    const sig = Array.from({ length: n }, (_, i) => (i % 7) - 3);
    const ret = sig.map((v) => v * 0.01);
    const dense = rollingIcSeries(sig, ret, 100, 1);
    const sparse = rollingIcSeries(sig, ret, 100, 10);
    expect(dense.length).toBeGreaterThan(sparse.length);
  });
});

describe('analyzeSignal 综合判定', () => {
  it('强有效信号：IC 高、t 值大、判定为显著', () => {
    // 构造持续为正的 IC 序列（均值 0.05，波动小）
    const ics = Array.from({ length: 500 }, (_, i) => 0.05 + Math.sin(i) * 0.01);
    const r = analyzeSignal('good_signal', ics);
    expect(r.ic).toBeCloseTo(0.05, 2);
    expect(Math.abs(r.tStat)).toBeGreaterThan(2);
    expect(r.significant).toBe(true);
    expect(r.sampleSize).toBe(500);
  });

  it('纯噪声信号：IC 接近 0、t 值小、判定为不显著', () => {
    // 零均值噪声
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * 2 - 1;
    };
    const ics = Array.from({ length: 500 }, () => rnd() * 0.03);
    const r = analyzeSignal('noise_signal', ics);
    expect(Math.abs(r.ic)).toBeLessThan(0.01);
    expect(Math.abs(r.tStat)).toBeLessThan(2);
    expect(r.significant).toBe(false);
  });

  it('自相关会削弱 t 值（HAC 生效的证据）', () => {
    // 同样的均值，一个白噪声、一个强自相关
    const base = 0.04;
    const white = Array.from({ length: 400 }, (_, i) =>
      i % 2 === 0 ? base + 0.01 : base - 0.01,
    );
    let prev = 0;
    const autocorr = Array.from({ length: 400 }, (_, i) => {
      prev = 0.95 * prev + 0.05 * (i % 2 === 0 ? 1 : -1) * 10;
      return base + prev * 0.01;
    });
    const rWhite = analyzeSignal('white', white);
    const rAuto = analyzeSignal('auto', autocorr);
    // 两者均值相近，但自相关的标准误更大 → t 值更小
    expect(rAuto.hacStdErr).toBeGreaterThan(rWhite.hacStdErr);
  });

  it('样本不足时安全返回（不产生误导性结果）', () => {
    const r = analyzeSignal('tiny', [0.05]);
    expect(r.sampleSize).toBe(1);
    expect(r.significant).toBe(false);
    expect(r.tStat).toBe(0);
  });

  it('含 NaN 的序列被过滤', () => {
    const r = analyzeSignal('with_nan', [0.05, NaN, 0.05, 0.05, NaN, 0.05]);
    expect(r.sampleSize).toBe(4);
  });

  it('分位收益与单调性被正确计算', () => {
    // 递增的 IC 序列 → 分位收益应单调递增
    const ics = Array.from({ length: 300 }, (_, i) => (i / 300) * 0.1);
    const r = analyzeSignal('trending', ics);
    expect(r.quantileReturns).toHaveLength(5);
    expect(r.monotonic).toBe(true);
    expect(r.q5MinusQ1).toBeGreaterThan(0);
  });

  it('IR = IC均值/IC标准差', () => {
    const ics = [0.05, 0.05, 0.05, 0.05, 0.06, 0.04];
    const r = analyzeSignal('ir_test', ics);
    const expected = mean(ics) / std(ics);
    expect(r.ir).toBeCloseTo(expected, 3);
  });

  it('自定义门槛生效', () => {
    // 注意：用带轻微波动的序列——完全恒定的序列 std=0 会导致 t 值无意义（除零保护返回 0）
    const ics = Array.from({ length: 300 }, (_, i) => 0.03 + (i % 2 === 0 ? 0.005 : -0.005));
    // 默认门槛 t>=2 且 ic>=0.02 → 显著
    expect(analyzeSignal('x', ics).significant).toBe(true);
    // 收紧 IC 门槛到 0.05 → 不显著（IC 均值 0.03 < 0.05）
    expect(analyzeSignal('x', ics, { icThreshold: 0.05 }).significant).toBe(false);
    // 收紧 t 门槛到 10000 → 不显著
    expect(analyzeSignal('x', ics, { tThreshold: 10000 }).significant).toBe(false);
  });

  it('完全恒定的 IC 序列不产生虚高的 t 值（std=0 保护）', () => {
    // 恒定序列标准差为 0，HAC 标准误也为 0 → t 值应为 0 而非 Infinity
    const r = analyzeSignal('constant', Array.from({ length: 100 }, () => 0.03));
    expect(Number.isFinite(r.tStat)).toBe(true);
    expect(r.icStd).toBe(0);
  });
});
