import { describe, expect, it } from 'vitest';
import {
  gapToTrigger,
  mapRiskRejectToBlockingCode,
  proximityToTrigger,
  type BlockingReasonCode,
} from '../../decision-diagnostics';
import { scoreSignals, scoreSignalsDetailed } from '../../indicators/signals';
import { TrendFollowingStrategy } from '../trend-following';
import { MeanReversionStrategy } from '../mean-reversion';
import type { Signal } from '../../types/agent';

function sig(name: string, weight: number, bias: Signal['bias']): Signal {
  return { name, label: name, value: '', bias, weight, note: '' };
}

/** 六信号（与 buildSignals 同权重）：趋势 .25 / rsi .2 / macd .2 / boll .15 / volume .1 / mid .1 */
const ALL_BULL: Signal[] = [
  sig('ma_trend', 0.25, 'bullish'),
  sig('rsi', 0.2, 'bullish'),
  sig('macd', 0.2, 'bullish'),
  sig('bollinger', 0.15, 'bullish'),
  sig('volume', 0.1, 'bullish'),
  sig('mid_term', 0.1, 'bullish'),
];

describe('scoreSignalsDetailed 与 scoreSignals 同口径', () => {
  it('任意组合下 score 字段必须严格相等（零回归风险）', () => {
    const variants: Signal[][] = [
      ALL_BULL,
      ALL_BULL.map((s) => ({ ...s, bias: 'bearish' as const })),
      // bollinger 弃权（真实场景中约 80% 时间如此）
      ALL_BULL.map((s) => (s.name === 'bollinger' ? { ...s, bias: 'neutral' as const } : s)),
      // rsi 弃权
      ALL_BULL.map((s) => (s.name === 'rsi' ? { ...s, bias: 'neutral' as const } : s)),
      // boll + volume 皆弃权
      ALL_BULL.map((s) =>
        s.name === 'bollinger' || s.name === 'volume' ? { ...s, bias: 'neutral' as const } : s,
      ),
      // 全部弃权
      ALL_BULL.map((s) => ({ ...s, bias: 'neutral' as const })),
      [],
    ];

    for (const signals of variants) {
      expect(scoreSignalsDetailed(signals).score).toBe(scoreSignals(signals));
    }
  });

  it('复现方案根因二：bollinger 弃权时全多也只有 0.85（恰好卡死在阈值）', () => {
    const withBollNeutral = ALL_BULL.map((s) =>
      s.name === 'bollinger' ? { ...s, bias: 'neutral' as const } : s,
    );
    const d = scoreSignalsDetailed(withBollNeutral, 0.85);
    expect(d.score).toBe(0.85);
    // 恰好触及，gap 为 0
    expect(d.gapToThreshold).toBe(0);
    expect(d.agreement).toBeCloseTo(0.85, 4);
  });

  it('rsi 弃权时 0.80、boll+volume 弃权时 0.75 —— 均低于 0.85 阈值', () => {
    const rsiNeutral = ALL_BULL.map((s) => (s.name === 'rsi' ? { ...s, bias: 'neutral' as const } : s));
    // 旧口径被稀释：0.80 < 0.85 阈值，够不到
    expect(scoreSignalsDetailed(rsiNeutral).score).toBe(0.8);
    // 新口径不受稀释影响：表态者全看多 → consensus=1，差距为 0（这正是 B2 要修复的）
    expect(scoreSignalsDetailed(rsiNeutral, 0.85).consensus).toBe(1);
    expect(scoreSignalsDetailed(rsiNeutral, 0.85).gapToThreshold).toBe(0);

    const twoNeutral = ALL_BULL.map((s) =>
      s.name === 'bollinger' || s.name === 'volume' ? { ...s, bias: 'neutral' as const } : s,
    );
    expect(scoreSignalsDetailed(twoNeutral).score).toBe(0.75);
    expect(scoreSignalsDetailed(twoNeutral, 0.85).consensus).toBe(1);
  });

  it('contributions 按影响力降序，且 signed 符号正确', () => {
    const d = scoreSignalsDetailed(ALL_BULL);
    expect(d.contributions[0].name).toBe('ma_trend'); // 权重最大
    for (const c of d.contributions) {
      expect(c.signed).toBe(c.bias === 'bullish' ? c.weight : c.bias === 'bearish' ? -c.weight : 0);
    }
  });

  it('agreement 正确表达参与表态的权重占比', () => {
    expect(scoreSignalsDetailed(ALL_BULL).agreement).toBe(1);
    const halfNeutral = ALL_BULL.map((s) => ({ ...s, bias: 'neutral' as const }));
    expect(scoreSignalsDetailed(halfNeutral).agreement).toBe(0);
  });
});

describe('接近度与差距', () => {
  it('proximity 与 gap 互补，且已触发时为 1/0', () => {
    expect(proximityToTrigger(0.65, 0.85)).toBeCloseTo(0.765, 2);
    expect(gapToTrigger(0.65, 0.85)).toBeCloseTo(0.235, 2);
    expect(proximityToTrigger(0.85, 0.85)).toBe(1);
    expect(gapToTrigger(0.85, 0.85)).toBe(0);
    expect(proximityToTrigger(0.9, 0.85)).toBe(1); // 超过阈值封顶
  });

  it('负分取绝对值计算', () => {
    expect(proximityToTrigger(-0.65, 0.85)).toBe(proximityToTrigger(0.65, 0.85));
  });

  it('阈值 0 时不除零', () => {
    expect(proximityToTrigger(0.5, 0)).toBe(1);
    expect(gapToTrigger(0.5, 0)).toBe(0);
  });
});

/**
 * 真实场景的信号组合：ma_trend + macd + mid_term + volume 看多，
 * rsi（45~55）与 bollinger（%b 居中的 80% 时间）双双弃权 → score = 0.65。
 * 这正是方案 1.3 表格中「rsi + boll 皆 neutral → 0.75」的近亲场景，
 * 也是线上实测 indicatorScore 绝对值最高仅 0.65 的成因。
 */
const SCORE_065: Signal[] = [
  sig('ma_trend', 0.25, 'bullish'),
  sig('rsi', 0.2, 'neutral'),
  sig('macd', 0.2, 'bullish'),
  sig('bollinger', 0.15, 'neutral'),
  sig('volume', 0.1, 'bullish'),
  sig('mid_term', 0.1, 'bullish'),
];

describe('trend_following 输出诊断信息', () => {
  const base = {
    symbol: 'BTCUSDT',
    timeframe: '5m' as const,
    candles: [],
    indicators: {} as never,
    // signals 与 indicatorScore 必须同源（真实场景二者一致，由 buildSignals + scoreSignals 产出）
    signals: SCORE_065,
    indicatorScore: scoreSignals(SCORE_065), // 0.65，低于 0.85 → 必然 HOLD
    ticker: {} as never,
    position: null,
    account: { quoteFree: 1000, baseFree: 0 },
    params: {},
  };

  it('观望时携带 proximity 与归因，而非 confidence=0 一无所知', () => {
    const out = new TrendFollowingStrategy().evaluate(base);
    expect(out.action).toBe('HOLD');
    expect(out.confidence).toBe(0);
    // 关键：proximity 有值，能表达「差多少」
    expect(out.proximity).toBeCloseTo(0.765, 2);
    expect(out.diagnostics?.code).toBe('SIGNAL_NONE');
    expect(out.diagnostics?.gapToTrigger).toBeCloseTo(0.2, 4);
    expect(out.diagnostics?.score).toBe(0.65);
    expect(out.diagnostics?.requiredScore).toBe(0.85);
    expect(out.diagnostics?.contributions).toHaveLength(6);
  });

  it('触发时不带阻塞码（没有"阻塞"这回事）', () => {
    const out = new TrendFollowingStrategy().evaluate({ ...base, indicatorScore: 0.9 });
    expect(out.action).toBe('BUY');
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.diagnostics?.code).toBeUndefined();
  });

  it('reason 文本含接近度，便于日志排查', () => {
    const out = new TrendFollowingStrategy().evaluate(base);
    expect(out.reason).toContain('未达开仓阈值');
    expect(out.reason).toContain('%');
  });
});

describe('mean_reversion 输出诊断信息', () => {
  const strat = new MeanReversionStrategy();

  it('指标缺失时报 INDICATOR_NAN（与"信号未触发"区分开）', () => {
    const out = strat.evaluate({
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: { rsi14: NaN, bollUpper: NaN, bollLower: NaN, lastClose: 0 } as never,
      signals: [],
      indicatorScore: 0,
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: {},
    });
    expect(out.action).toBe('HOLD');
    expect(out.diagnostics?.code).toBe('INDICATOR_NAN');
    expect(out.proximity).toBe(0);
  });

  it('中性区间时报 SIGNAL_NONE，且 proximity 在 0~1 内', () => {
    const out = strat.evaluate({
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      // %b = 0.5 居中、RSI 50 中性 → 双条件均不达标
      indicators: { rsi14: 50, bollUpper: 110, bollLower: 90, lastClose: 100 } as never,
      signals: ALL_BULL,
      indicatorScore: 0,
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: {},
    });
    expect(out.action).toBe('HOLD');
    expect(out.diagnostics?.code).toBe('SIGNAL_NONE');
    expect(out.proximity!).toBeGreaterThanOrEqual(0);
    expect(out.proximity!).toBeLessThanOrEqual(1);
  });

  it('贴近触发区时 proximity 显著高于中性区（接近度的核心价值）', () => {
    // bandPos = (lastClose - 90) / (110 - 90)
    const evalAt = (lastClose: number, rsi: number) =>
      strat.evaluate({
        symbol: 'BTCUSDT',
        timeframe: '5m' as const,
        candles: [],
        indicators: { rsi14: rsi, bollUpper: 110, bollLower: 90, lastClose } as never,
        signals: [],
        indicatorScore: 0,
        ticker: {} as never,
        position: null,
        account: { quoteFree: 1000, baseFree: 0 },
        params: {},
      }).proximity!;

    // 中性区：%b=0.5 居中、RSI=50 中性 → 距两个触发方向都远
    const neutral = evalAt(100, 50);
    // 贴近下轨触发区：%b=0.05（恰在下轨区）+ RSI=32（接近超卖 30）
    const nearBuy = evalAt(91, 32);

    expect(nearBuy).toBeGreaterThan(neutral);
    expect(nearBuy).toBeGreaterThan(0.9); // 已非常接近触发
    expect(neutral).toBeLessThan(0.6); // 中性区明显更远
  });

  it('双条件木桶效应：单一条件达标而另一条件远离时，接近度被最弱项限制', () => {
    // RSI 已超卖（25 <= 30），但 %b=0.5 远离下轨区（0.05）
    // → 做多方向的接近度由 band 决定：0.05 / 0.5 = 0.1，而非 1
    const out = strat.evaluate({
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: { rsi14: 25, bollUpper: 110, bollLower: 90, lastClose: 100 } as never,
      signals: [],
      indicatorScore: 0,
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: {},
    });
    expect(out.action).toBe('HOLD');
    // 做空方向：bandToSell = 0.5/0.95 ≈ 0.526，rsiToSell = 25/70 ≈ 0.357 → 0.357
    // 做多方向：bandToBuy = 0.05/0.5 = 0.1，rsiToBuy = 1（已超卖）→ 0.1
    // proximity = max(0.1, 0.357) ≈ 0.357 —— 被最弱的项限制，而非取 RSI 的满分
    expect(out.proximity!).toBeLessThan(0.5);
  });
});

describe('B2 · 打分口径（legacy vs consensus）', () => {
  /**
   * 背景：旧口径分母含弃权信号，导致"六信号全看多但 bollinger 弃权"时 score 只有 0.85、
   * rsi+boll 双弃权仅 0.75，够不到已校准的 0.85 阈值（线上实测绝对值最高仅 0.65）。
   * consensus 口径分子分母都只算表态信号，不再被稀释。
   */

  it('consensus 不被弃权稀释：任意弃权组合下，全同向表态时恒为 ±1', () => {
    for (const dropped of [[], ['bollinger'], ['rsi'], ['bollinger', 'volume'], ['rsi', 'bollinger']]) {
      const signals = ALL_BULL.map((s) =>
        dropped.includes(s.name) ? { ...s, bias: 'neutral' as const } : s,
      );
      expect(scoreSignalsDetailed(signals).consensus).toBe(1);
    }
  });

  it('对比：同样弃权下 legacy score 被稀释，consensus 保持满值', () => {
    const withBollNeutral = ALL_BULL.map((s) =>
      s.name === 'bollinger' ? { ...s, bias: 'neutral' as const } : s,
    );
    const d = scoreSignalsDetailed(withBollNeutral);
    expect(d.score).toBe(0.85); // 旧口径被稀释
    expect(d.consensus).toBe(1); // 新口径不受影响
    expect(d.agreement).toBe(0.85);
  });

  it('方向不一致时 consensus 反映净一致度（表态者内部的分歧）', () => {
    // ma_trend+macd 看多(0.45)，rsi+volume 看空(0.3)，mid_term 弃权(0.1)，bollinger 弃权(0.15)
    const mixed = [
      sig('ma_trend', 0.25, 'bullish'),
      sig('rsi', 0.2, 'bearish'),
      sig('macd', 0.2, 'bullish'),
      sig('bollinger', 0.15, 'neutral'),
      sig('volume', 0.1, 'bearish'),
      sig('mid_term', 0.1, 'neutral'),
    ];
    const d = scoreSignalsDetailed(mixed);
    // 表态权重 = 0.25+0.2+0.2+0.1 = 0.75；净值 = 0.25-0.2+0.2-0.1 = 0.15
    expect(d.activeWeight).toBeCloseTo(0.75, 4);
    expect(d.consensus).toBeCloseTo(0.2, 4); // 0.15 / 0.75
    expect(d.agreement).toBeCloseTo(0.75, 4);
    // 旧口径：0.15 / 1.0 = 0.15，比新口径更低（双重稀释）
    expect(d.score).toBeCloseTo(0.15, 4);
  });

  it('全部弃权时两口径均为 0，不除零', () => {
    const allNeutral = ALL_BULL.map((s) => ({ ...s, bias: 'neutral' as const }));
    const d = scoreSignalsDetailed(allNeutral, 0.85);
    expect(d.score).toBe(0);
    expect(d.consensus).toBe(0);
    expect(d.agreement).toBe(0);
    // 无人表态 → 差距即完整阈值（activeWeight=0 的分支）
    expect(d.gapToThreshold).toBe(0.85);
  });

  it('空信号数组不崩溃', () => {
    const d = scoreSignalsDetailed([], 0.85);
    expect(d.score).toBe(0);
    expect(d.consensus).toBe(0);
    expect(d.agreement).toBe(0);
  });

  it('【零回归】默认 legacy 模式行为与改造前完全一致', () => {
    // 默认不传 params → scoreMode='legacy'，必须沿用 ctx.indicatorScore，逐字节一致
    const ctx = {
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: {} as never,
      signals: SCORE_065,
      indicatorScore: scoreSignals(SCORE_065),
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
    };
    const legacyOut = new TrendFollowingStrategy().evaluate({ ...ctx, params: {} });
    // 0.65 < 0.85 → 仍为 HOLD，proximity 仍是 0.765（与 A 期测试同值）
    expect(legacyOut.action).toBe('HOLD');
    expect(legacyOut.proximity).toBeCloseTo(0.765, 2);
  });

  it('consensus 模式：同样的信号与阈值可以触发（不再被稀释）', () => {
    // rsi + bollinger 双双弃权：legacy score = 0.75（够不到 0.85）
    // consensus = 1.0（四个表态信号全看多），agreement = 0.75 >= minAgreement 0.6 → 触发
    const signals: Signal[] = [
      sig('ma_trend', 0.25, 'bullish'),
      sig('rsi', 0.2, 'neutral'),
      sig('macd', 0.2, 'bullish'),
      sig('bollinger', 0.15, 'neutral'),
      sig('volume', 0.1, 'bullish'),
      sig('mid_term', 0.1, 'bullish'),
    ];
    const base = {
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: {} as never,
      signals,
      indicatorScore: scoreSignals(signals), // 0.75，legacy 口径
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
    };

    const legacy = new TrendFollowingStrategy().evaluate({ ...base, params: { scoreMode: 'legacy' } });
    const cons = new TrendFollowingStrategy().evaluate({
      ...base,
      params: { scoreMode: 'consensus', minAgreement: 0.6 },
    });

    expect(legacy.action).toBe('HOLD'); // 被稀释，够不到
    expect(cons.action).toBe('BUY'); // 新口径触发
    expect(cons.confidence).toBeGreaterThan(0);
  });

  it('consensus 模式：表态率不足时不触发（防止单信号独断）', () => {
    // 只有 ma_trend(0.25) 表态且看多，其余五个全弃权
    // consensus = 1.0（唯一表态者"完全一致"），但 agreement = 0.25 < 0.6 → 拒绝
    const signals: Signal[] = [
      sig('ma_trend', 0.25, 'bullish'),
      sig('rsi', 0.2, 'neutral'),
      sig('macd', 0.2, 'neutral'),
      sig('bollinger', 0.15, 'neutral'),
      sig('volume', 0.1, 'neutral'),
      sig('mid_term', 0.1, 'neutral'),
    ];
    const out = new TrendFollowingStrategy().evaluate({
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: {} as never,
      signals,
      indicatorScore: scoreSignals(signals),
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: { scoreMode: 'consensus', minAgreement: 0.6, entryThreshold: 0.85 },
    });
    expect(out.action).toBe('HOLD');
    // 接近度按木桶效应取较小值：agreement 0.25/0.6 = 0.417 < score 的 1.0
    expect(out.proximity).toBeCloseTo(0.417, 2);
  });

  it('consensus 模式：proximity 取双条件的较小值（木桶效应）', () => {
    const signals: Signal[] = [
      sig('ma_trend', 0.25, 'bullish'),
      sig('rsi', 0.2, 'bearish'), // 反对票：consensus 降到 (0.25-0.2)/1.0 = 0.05
      sig('macd', 0.2, 'neutral'),
      sig('bollinger', 0.15, 'neutral'),
      sig('volume', 0.1, 'neutral'),
      sig('mid_term', 0.1, 'neutral'),
    ];
    const out = new TrendFollowingStrategy().evaluate({
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: {} as never,
      signals,
      indicatorScore: scoreSignals(signals),
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: { scoreMode: 'consensus', minAgreement: 0.6, entryThreshold: 0.85 },
    });
    // consensus = 0.05/0.45 ≈ 0.111 → 接近度 0.111/0.85 ≈ 0.131
    // agreement = 0.45 → 接近度 0.45/0.6 = 0.75
    // 木桶效应取较小值 ≈ 0.131
    expect(out.proximity!).toBeLessThan(0.2);
    expect(out.action).toBe('HOLD');
  });

  it('参数兜底：脏 params 不崩溃且回落安全值', () => {
    const base = {
      symbol: 'BTCUSDT',
      timeframe: '5m' as const,
      candles: [],
      indicators: {} as never,
      signals: ALL_BULL,
      indicatorScore: 1,
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
    };
    // scoreMode 传非法值 → 回落 legacy
    expect(new TrendFollowingStrategy().evaluate({ ...base, params: { scoreMode: 'bogus' } }).action).toBe('BUY');
    // minAgreement 传 NaN → 回落默认 0.6
    expect(() =>
      new TrendFollowingStrategy().evaluate({
        ...base,
        params: { scoreMode: 'consensus', minAgreement: NaN },
      }),
    ).not.toThrow();
  });
});

describe('B4 · mean_reversion 回归出场（修复只买不卖）', () => {
  const strat = new MeanReversionStrategy();

  /** 构造上下文：indicators 决定 %b 与 RSI，position 决定是否持仓 */
  const ctxAt = (lastClose: number, rsi: number, posQty: number) => ({
    symbol: 'BTCUSDT',
    timeframe: '5m' as const,
    candles: [],
    // bollUpper=110 / bollLower=90 → %b = (close-90)/20
    indicators: { rsi14: rsi, bollUpper: 110, bollLower: 90, lastClose } as never,
    signals: [],
    indicatorScore: 0,
    ticker: {} as never,
    position: posQty > 0 ? ({ symbol: 'BTCUSDT', quantity: posQty, avgCost: 91 } as never) : null,
    account: { quoteFree: 1000, baseFree: 0 },
    params: {},
  });

  it('持多仓 + 价格回归中轨 → SELL（修复前此场景恒为 HOLD）', () => {
    // %b = (100-90)/20 = 0.5，正处出场带 [0.4,0.6]
    const out = strat.evaluate(ctxAt(100, 50, 0.005));
    expect(out.action).toBe('SELL');
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.reason).toContain('回归均值');
  });

  it('持多仓 + 仍在下轨区（未回归）→ 不卖出，继续持有', () => {
    // %b = 0.1，未到出场带
    const out = strat.evaluate(ctxAt(92, 35, 0.005));
    expect(out.action).toBe('HOLD');
  });

  it('持多仓 + 反向超买极端 → 仍可 SELL（次级兜底保留）', () => {
    // %b = 0.98 触上轨 + RSI 78 超买
    const out = strat.evaluate(ctxAt(109.6, 78, 0.005));
    expect(out.action).toBe('SELL');
    expect(out.reason).toContain('上轨区'); // 走的是原反向极端分支
  });

  it('持多仓 + 再次超卖 → 不加仓（不输出 BUY，防止无限加仓）', () => {
    const out = strat.evaluate(ctxAt(91, 25, 0.005));
    expect(out.action).not.toBe('BUY');
  });

  it('无持仓 + 回归中轨 → HOLD（出场逻辑只对持仓生效）', () => {
    const out = strat.evaluate(ctxAt(100, 50, 0));
    expect(out.action).toBe('HOLD');
  });

  it('无持仓 + 超卖极端 → BUY（开仓逻辑不受影响）', () => {
    // %b = 0.05 触下轨 + RSI 25 超卖
    const out = strat.evaluate(ctxAt(91, 25, 0));
    expect(out.action).toBe('BUY');
  });

  it('出场带参数可调：收紧到 [0.48,0.52] 后 %b=0.45 不再出场', () => {
    const out = strat.evaluate({
      ...ctxAt(99, 50, 0.005), // %b = 0.45
      params: { exitBandPosLow: 0.48, exitBandPosHigh: 0.52 },
    });
    expect(out.action).toBe('HOLD');
  });

  it('脏参数回落默认出场带（不崩溃）', () => {
    const out = strat.evaluate({
      ...ctxAt(100, 50, 0.005),
      params: { exitBandPosLow: NaN, exitBandPosHigh: 'bogus' as never },
    });
    expect(out.action).toBe('SELL'); // 默认 [0.4,0.6] 仍覆盖 0.5
  });

  it('回归深度越接近中轨置信越高', () => {
    const mid = strat.evaluate(ctxAt(100, 50, 0.005)); // %b=0.5 正中
    const edge = strat.evaluate(ctxAt(98.2, 50, 0.005)); // %b=0.41 贴近带边
    expect(mid.confidence).toBeGreaterThan(edge.confidence);
  });
});

describe('风控拦截码映射（跨层级归因）', () => {
  it('风控层 rejectedBy 能映射到统一的 BlockingReasonCode', () => {
    expect(mapRiskRejectToBlockingCode('MAX_ORDER_AMOUNT')).toBe('RISK_MAX_ORDER_AMOUNT');
    expect(mapRiskRejectToBlockingCode('MIN_ORDER_INTERVAL')).toBe('RISK_INTERVAL');
    expect(mapRiskRejectToBlockingCode('MAX_DRAWDOWN')).toBe('RISK_DRAWDOWN');
    expect(mapRiskRejectToBlockingCode('INSUFFICIENT_BALANCE')).toBe('RISK_INSUFFICIENT_BALANCE');
    expect(mapRiskRejectToBlockingCode('MAX_EXPOSURE')).toBe('RISK_MAX_EXPOSURE');
    expect(mapRiskRejectToBlockingCode('MAX_DAILY_ORDERS')).toBe('RISK_MAX_DAILY_ORDERS');
    expect(mapRiskRejectToBlockingCode('DAILY_LOSS_LIMIT')).toBe('RISK_DAILY_LOSS');
    expect(mapRiskRejectToBlockingCode('LIVE_MODE_CONFIRM_REQUIRED')).toBe('RISK_CONFIRM_REQUIRED');
  });

  it('引擎层拦截码也能映射（置信度/最小量/无价格）', () => {
    expect(mapRiskRejectToBlockingCode('MIN_CONFIDENCE')).toBe('BELOW_MIN_CONFIDENCE');
    expect(mapRiskRejectToBlockingCode('MIN_QTY')).toBe('RISK_MIN_NOTIONAL');
    expect(mapRiskRejectToBlockingCode('NO_PRICE')).toBe('STALE_DATA');
  });

  it('空值与未知码安全返回 null（不污染聚合统计）', () => {
    expect(mapRiskRejectToBlockingCode(null)).toBeNull();
    expect(mapRiskRejectToBlockingCode(undefined)).toBeNull();
    expect(mapRiskRejectToBlockingCode('SOME_UNKNOWN_CODE')).toBeNull();
  });

  it('回归：线上实测的 MAX_ORDER_AMOUNT 能被正确归因到风控层', () => {
    // 实测踩过的坑：12 次 BUY 全被 MAX_ORDER_AMOUNT 拦截，
    // 但诊断只显示 SIGNAL_NONE（策略层），归因到错误的层级。
    // 本断言确保这类拦截能被识别成风控问题，而非"信号没触发"。
    const code = mapRiskRejectToBlockingCode('MAX_ORDER_AMOUNT');
    expect(code).not.toBe('SIGNAL_NONE');
    expect(code?.startsWith('RISK_')).toBe(true);
  });
});

describe('BlockingReasonCode 覆盖主要阻塞场景', () => {
  it('方案定义的场景均有对应码', () => {
    const codes: BlockingReasonCode[] = [
      'NO_CANDLES',
      'INDICATOR_NAN',
      'STALE_DATA',
      'SIGNAL_NONE',
      'SIGNAL_CONFLICT',
      'BELOW_MIN_CONFIDENCE',
      'STRATEGY_FALLBACK',
      'RISK_MIN_NOTIONAL',
      'RISK_MARGIN',
      'RISK_LIQUIDATION_DIST',
      'RISK_LEVERAGE_CLAMPED',
      'RISK_INTERVAL',
      'RISK_DRAWDOWN',
      'BROKER_REJECTED',
      'ENGINE_ERROR',
    ];
    // 覆盖数据/信号/决策/风控/执行五个层
    expect(codes).toHaveLength(15);
  });
});
