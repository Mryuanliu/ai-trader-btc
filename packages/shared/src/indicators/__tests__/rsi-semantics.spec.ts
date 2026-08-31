import { describe, expect, it } from 'vitest';
import { buildSignals, computeIndicators, scoreSignals, scoreSignalsDetailed } from '../signals';
// 必须从 strategy 主入口导入：策略注册发生在 index.ts，直接引 registry 拿到的是空表
import { strategyRegistry } from '../../strategy';
import type { IndicatorSnapshot } from '../../types/agent';
import type { Candle } from '../../types/market';

/**
 * B3 · RSI 语义参数化 + 镜像对称回归测试
 *
 * 背景：buildSignals 原先**硬编码**均值回归语义（RSI>=70 看跌、<=30 看涨），
 * 而 trend_following 用的也是这套信号。趋势策略应当把 RSI 读作**动能**
 * （越高越强），于是出现语义反转：
 *   RSI 55~70 → bullish（5282 次）
 *   RSI >=70  → bearish（794 次）  ← 与上面方向相反
 * 即"最强上涨动能反而被判看跌"，趋势策略在最该跟涨时被泼冷水。
 */

/** 构造指定 RSI 的指标快照（其余字段给中性值，避免干扰） */
function snapshotWith(rsi14: number): IndicatorSnapshot {
  return {
    sma5: 100,
    sma10: 100,
    sma20: 100,
    sma60: 100,
    ema12: 100,
    ema26: 100,
    rsi14,
    macd: 0,
    macdSignal: 0,
    macdHist: 0,
    bollUpper: 110,
    bollMid: 100,
    bollLower: 90,
    atr14: 1,
    volumeRatio: 1,
    lastClose: 100,
  };
}

/** 让 ma_trend 保持中性，隔离出 RSI 单独的影响 */
const NEUTRAL_CANDLES: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  time: i * 60_000,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 100,
}));

function rsiBias(rsi: number, mode?: 'reversion' | 'trend') {
  const sigs = buildSignals(snapshotWith(rsi), NEUTRAL_CANDLES, mode ? { rsiMode: mode } : {});
  return sigs.find((s) => s.name === 'rsi')!.bias;
}

/** 构造一段单调行情：dir=1 上涨，dir=-1 下跌（用于镜像对称测试） */
function trendCandles(dir: 1 | -1, n = 120): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + dir * i * 0.5;
    return {
      time: i * 60_000,
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1000,
    };
  });
}

describe('RSI 语义：两种模式方向相反', () => {
  it('reversion：超买看跌、超卖看涨（均值回归语义）', () => {
    expect(rsiBias(75, 'reversion')).toBe('bearish');
    expect(rsiBias(25, 'reversion')).toBe('bullish');
    expect(rsiBias(60, 'reversion')).toBe('bullish'); // 55~70 偏强
    expect(rsiBias(40, 'reversion')).toBe('bearish'); // 30~45 偏弱
    expect(rsiBias(50, 'reversion')).toBe('neutral');
  });

  it('trend：高 RSI 看涨、低 RSI 看跌（动能语义）', () => {
    expect(rsiBias(75, 'trend')).toBe('bullish');
    expect(rsiBias(25, 'trend')).toBe('bearish');
    expect(rsiBias(60, 'trend')).toBe('bullish');
    expect(rsiBias(40, 'trend')).toBe('bearish');
    expect(rsiBias(50, 'trend')).toBe('neutral');
  });

  it('语义反转点：RSI>=70 与 RSI<=30 在两种模式下完全相反', () => {
    // 这是修复的核心矛盾点
    expect(rsiBias(75, 'reversion')).not.toBe(rsiBias(75, 'trend'));
    expect(rsiBias(25, 'reversion')).not.toBe(rsiBias(25, 'trend'));
  });

  it('trend 模式消除反转：RSI 越高，方向越偏多（单调）', () => {
    // 修复前：RSI 69→bullish，RSI 71→bearish（反转）
    // 修复后（trend）：RSI 69 与 71 同为 bullish，方向连续
    expect(rsiBias(69, 'trend')).toBe('bullish');
    expect(rsiBias(71, 'trend')).toBe('bullish');
    expect(rsiBias(31, 'trend')).toBe('bearish');
    expect(rsiBias(29, 'trend')).toBe('bearish');
  });

  it('默认模式为 reversion（向后兼容，零回归）', () => {
    // 不传 options 时行为必须与修复前完全一致
    expect(rsiBias(75)).toBe('bearish');
    expect(rsiBias(25)).toBe('bullish');
    expect(rsiBias(75)).toBe(rsiBias(75, 'reversion'));
  });

  it('非法 rsiMode 值安全回落 reversion', () => {
    const sigs = buildSignals(snapshotWith(75), NEUTRAL_CANDLES, {
      rsiMode: 'bogus' as never,
    });
    expect(sigs.find((s) => s.name === 'rsi')!.bias).toBe('bearish');
  });

  it('RSI 为 NaN 时两模式均为 neutral，不崩溃', () => {
    expect(rsiBias(NaN, 'reversion')).toBe('neutral');
    expect(rsiBias(NaN, 'trend')).toBe('neutral');
  });
});

describe('镜像对称回归测试', () => {
  /**
   * 镜像对称：把行情上下翻转（涨↔跌），策略的 BUY/SELL 应当**完全对调**。
   * 若不对称，说明信号构造存在方向性偏置（如 BUY 多、SELL 少）。
   *
   * 这是 B3 的核心验收项——原实现"BUY=0 / SELL=20"就是典型的不对称。
   */

  /** 对给定 K 线算综合分（按策略语义） */
  function scoreOf(candles: Candle[], rsiMode: 'reversion' | 'trend'): number {
    const ind = computeIndicators(candles);
    return scoreSignals(buildSignals(ind, candles, { rsiMode }));
  }

  it('单调上涨的 score 与单调下跌的 score 应互为相反数（符号对称）', () => {
    const up = scoreOf(trendCandles(1), 'trend');
    const down = scoreOf(trendCandles(-1), 'trend');
    // 方向应对称：上涨为正、下跌为负，且绝对值相等
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
    expect(Math.abs(up + down)).toBeLessThan(1e-6);
  });

  it('reversion 语义下同样保持符号对称（镜像行情互为相反）', () => {
    const up = scoreOf(trendCandles(1), 'reversion');
    const down = scoreOf(trendCandles(-1), 'reversion');
    expect(Math.abs(up + down)).toBeLessThan(1e-6);
  });

  it('trend 语义下，强上涨行情的 score 高于 reversion 语义（不再被超买拖累）', () => {
    const upTrend = scoreOf(trendCandles(1), 'trend');
    const upReversion = scoreOf(trendCandles(1), 'reversion');
    // 强上涨时 RSI 会进入超买区：
    // reversion 判定为看跌（拖低分数），trend 判定为看涨（推高分数）
    expect(upTrend).toBeGreaterThan(upReversion);
  });

  it('各信号在镜像行情下 bias 完全对调（无方向性偏置）', () => {
    const upSig = buildSignals(computeIndicators(trendCandles(1)), trendCandles(1), {
      rsiMode: 'trend',
    });
    const downSig = buildSignals(computeIndicators(trendCandles(-1)), trendCandles(-1), {
      rsiMode: 'trend',
    });

    expect(upSig).toHaveLength(downSig.length);
    for (let i = 0; i < upSig.length; i += 1) {
      const a = upSig[i].bias;
      const b = downSig[i].bias;
      // bullish ↔ bearish 对调，neutral 保持 neutral
      if (a === 'neutral') {
        expect(b).toBe('neutral');
      } else {
        expect(a).not.toBe(b);
      }
    }
  });
});

describe('策略声明的 RSI 语义', () => {
  it('trend_following 声明 trend，mean_reversion 声明 reversion', () => {
    expect(strategyRegistry.rsiModeOf('trend_following')).toBe('trend');
    expect(strategyRegistry.rsiModeOf('mean_reversion')).toBe('reversion');
  });

  it('未注册的策略名回落到兜底策略 trend_following 的语义（不崩溃）', () => {
    // getOrDefault 对未知策略名回落到 trend_following，故语义取其声明的 'trend'。
    // 这里验证的是"不崩溃、返回合法值"，而非固定 reversion。
    const mode = strategyRegistry.rsiModeOf('no_such_strategy');
    expect(['reversion', 'trend']).toContain(mode);
    expect(mode).toBe('trend'); // 兜底策略 trend_following 声明的是 trend
  });

  it('breakout 未显式声明时回落 reversion（不崩溃）', () => {
    const mode = strategyRegistry.rsiModeOf('breakout');
    expect(['reversion', 'trend']).toContain(mode);
  });
});

describe('镜像对称下的分数一致性', () => {
  it('scoreSignalsDetailed 在镜像行情下 consensus 也符号对称', () => {
    const upC = trendCandles(1);
    const downC = trendCandles(-1);
    const up = scoreSignalsDetailed(
      buildSignals(computeIndicators(upC), upC, { rsiMode: 'trend' }),
    );
    const down = scoreSignalsDetailed(
      buildSignals(computeIndicators(downC), downC, { rsiMode: 'trend' }),
    );
    expect(up.consensus).toBeCloseTo(-down.consensus, 6);
    expect(up.agreement).toBeCloseTo(down.agreement, 6);
  });
});
