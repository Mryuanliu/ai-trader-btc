import { DecisionInputSnapshot, Signal } from '@ai-trader/shared';

/** 只把最近 N 根 K 线压缩进 Prompt，控制 token 消耗 */
const CANDLE_SUMMARY_COUNT = 24;

/** 行情/新闻/账户摘要（hybrid 上下文分析使用） */
function buildMarketBrief(
  snapshot: DecisionInputSnapshot,
  klineLines: string[],
  indicatorLines: string[],
  signalLines: string[],
  newsLines: string[],
): string[] {
  const a = snapshot.account;
  return [
    `标的：${snapshot.symbol}（${snapshot.timeframe} 周期）`,
    '',
    '## 一、最近 K 线（时间 开/高/低/收/量）',
    ...klineLines,
    '',
    '## 二、技术指标',
    ...indicatorLines,
    '',
    '## 三、指标信号（加权后综合倾向 ' + snapshot.indicatorScore.toFixed(2) + '，取值 -1 极度看空 ~ +1 极度看多）',
    ...signalLines,
    '',
    '## 四、近期新闻',
    ...newsLines,
    '',
    '## 五、账户状态',
    `运行模式：${a.mode}（${a.environment}）`,
    `可用 USDT：${a.quoteFree.toFixed(2)}`,
    `可用 BTC：${a.baseFree.toFixed(6)}`,
    '',
  ];
}

/**
 * hybrid 链路：让 AI 只输出市场上下文元参数，不下达买卖指令。
 * 买卖决策由确定性策略根据这些元参数映射后的参数独立完成（可回测、可审计）。
 * 注：原让 AI 直出 BUY/SELL/HOLD 的 prompt 已移除。
 */
export function buildContextPrompt(snapshot: DecisionInputSnapshot): string {
  const klines = snapshot.candles.slice(-CANDLE_SUMMARY_COUNT);
  const klineLines = klines.map(
    (c) =>
      `${new Date(c.time).toISOString().slice(5, 16)} O${c.open.toFixed(2)} H${c.high.toFixed(2)} L${c.low.toFixed(2)} C${c.close.toFixed(2)} V${c.volume.toFixed(2)}`,
  );

  const i = snapshot.indicators;
  const indicatorLines = [
    `收盘价 ${fmt(i.lastClose)}`,
    `SMA5 ${fmt(i.sma5)} / SMA10 ${fmt(i.sma10)} / SMA20 ${fmt(i.sma20)} / SMA60 ${fmt(i.sma60)}`,
    `EMA12 ${fmt(i.ema12)} / EMA26 ${fmt(i.ema26)}`,
    `RSI14 ${fmt(i.rsi14, 2)}`,
    `MACD ${fmt(i.macd, 2)} / Signal ${fmt(i.macdSignal, 2)} / Hist ${fmt(i.macdHist, 2)}`,
    `BOLL 上轨 ${fmt(i.bollUpper)} / 中轨 ${fmt(i.bollMid)} / 下轨 ${fmt(i.bollLower)}`,
    `ATR14 ${fmt(i.atr14, 2)}`,
    `量能比 ${fmt(i.volumeRatio, 2)}x`,
  ];

  const signalLines = snapshot.signals.map(
    (s) => `- ${s.label}: ${s.value}（${biasText(s.bias)}，权重 ${s.weight}）${s.note}`,
  );

  const newsLines = snapshot.news.length
    ? snapshot.news.map(
        (n, idx) => `${idx + 1}. [${n.source}] ${n.title}（${n.publishedAt.slice(0, 16)}）`,
      )
    : ['暂无相关新闻'];

  return [
    ...buildMarketBrief(snapshot, klineLines, indicatorLines, signalLines, newsLines),
    '## 输出要求',
    '你是市场状态分析器，不是交易员。禁止输出任何买卖指令（BUY/SELL/HOLD）。',
    '只输出一个 JSON 对象，不要任何解释文字与代码块标记，结构如下：',
    '{"regime":"trending|ranging|volatile","regimeConfidence":0.0~1.0,"aggression":0.0~1.0,"newsSentiment":-1.0~1.0,"positionView":"positive|neutral|negative","comment":"不超过 80 字的市场状态点评"}',
    '字段说明：',
    '- regime：当前市场状态。trending=趋势行情；ranging=震荡行情；volatile=高波动/极端行情。',
    '- regimeConfidence：对上述状态判断的置信度（0~1），不确定时给低值。',
    '- aggression：当前环境下建议的进攻程度（0=极度保守，1=极度激进）。参考趋势强度、波动率与信号一致性。',
    '- newsSentiment：近期新闻对 BTC 的综合情绪（-1 极度利空 ~ +1 极度利好），无新闻给 0。',
    '- positionView：持仓倾向，仅供人看，不参与策略映射（positive=适合持仓，neutral=中性，negative=建议减仓）。',
    '- comment：用一句话说明判断依据。',
  ].join('\n');
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
}

function biasText(bias: Signal['bias']): string {
  return bias === 'bullish' ? '偏多' : bias === 'bearish' ? '偏空' : '中性';
}
