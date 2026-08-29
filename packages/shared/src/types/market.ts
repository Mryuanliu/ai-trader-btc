import type { Environment, ExchangeCode, Timeframe } from './common';

/** 归一化 K 线，time 为毫秒开盘时间 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  /** 24h 绝对涨跌额 */
  change24h: number;
  /** 24h 涨跌幅，单位 % */
  changePercent24h: number;
  high24h: number;
  low24h: number;
  /** 24h 成交量（以 base 计价） */
  volume24h: number;
  /** 24h 成交额（以 quote 计价） */
  quoteVolume24h: number;
  ts: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface KlineQuery {
  symbol: string;
  interval: Timeframe;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

/** 今日市场整体动向 */
export interface MarketPulse {
  symbol: string;
  price: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  /** 24h 已实现波动率（%） */
  volatility24h: number;
  /** 今日成交量相对近 7 日均量的倍数 */
  volumeRatio: number;
  /** 近 24h 成交笔数（K 线根数代理） */
  candleCount: number;
  /** 情绪：牛/熊/震荡 */
  sentiment: 'bullish' | 'bearish' | 'neutral';
  /** 情绪分值 -100 ~ 100 */
  sentimentScore: number;
  summary: string;
  updatedAt: number;
}

export interface MarketSnapshot {
  exchange: ExchangeCode;
  environment: Environment;
  ticker: Ticker;
  candles: Candle[];
}

/** WebSocket 推送的实时价格 */
export interface PriceTick {
  symbol: string;
  price: number;
  changePercent24h: number;
  ts: number;
}
