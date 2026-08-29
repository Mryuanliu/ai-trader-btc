import { DecisionInputSnapshot, Signal } from '@ai-trader/shared';

/** 只把最近 N 根 K 线压缩进 Prompt，控制 token 消耗 */
const CANDLE_SUMMARY_COUNT = 24;

export function buildUserPrompt(snapshot: DecisionInputSnapshot): string {
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
    '## 输出要求',
    '只输出一个 JSON 对象，不要任何解释文字与代码块标记，结构如下：',
    '{"action":"BUY|SELL|HOLD","confidence":0.0~1.0,"reason":"不超过 80 字的决策理由","riskNotes":"需要注意的风险，可为空字符串"}',
    '约束：confidence 低于 0.6 时请直接给出 HOLD；行情矛盾或新闻面存在重大不确定性时优先 HOLD。',
  ].join('\n');
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
}

function biasText(bias: Signal['bias']): string {
  return bias === 'bullish' ? '偏多' : bias === 'bearish' ? '偏空' : '中性';
}
