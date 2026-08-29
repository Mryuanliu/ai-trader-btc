import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Candle,
  DEFAULT_SYMBOL,
  MarketPulse,
  Ticker,
  TIMEFRAMES,
  TIMEFRAME_MS,
  Timeframe,
  realizedVolatility,
} from '@ai-trader/shared';
import { CandleStoreService } from './candle-store.service';
import { SimulatedFeed } from './simulated-feed';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { EventBusService } from '../common/events';
import { EXCHANGE_CODES } from '@ai-trader/shared';

const HISTORY_COUNT: Record<Timeframe, number> = {
  '1m': 300,
  '5m': 300,
  '15m': 300,
  '1h': 300,
  '4h': 240,
  '1d': 180,
};

/** 高频报价约 100ms 一帧，聚合成秒级推送，避免前端被高频事件淹没 */
const PRICE_PUSH_INTERVAL_MS = 1000;
/** K 线流心跳超时：1m K 线约 2s 一帧，30s 无数据判定为断线 */
const KLINE_STALE_MS = 30_000;
/** 报价流心跳超时：最优报价约 100ms 一帧，15s 无数据判定为断线 */
const TICKER_STALE_MS = 15_000;
/** 实时报价有效期，超时后回落为 K 线收盘价 */
const LIVE_PRICE_TTL_MS = 10_000;

@Injectable()
export class MarketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketService.name);
  private readonly symbols = new Set<string>([DEFAULT_SYMBOL]);
  private readonly feeds = new Map<string, SimulatedFeed>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeTicker: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wsConnected = false;

  /** 最新高频报价：用于替代 1m K 线收盘价，让价格与指标跟随真实盘口 */
  private readonly livePrices = new Map<string, { price: number; ts: number }>();
  private lastPricePushAt = 0;
  /** 两路流各自的心跳时间戳，用于独立判定断线与重连 */
  private lastKlineAt = 0;
  private lastTickAt = 0;

  /** 行情来源：实时交易所 / 模拟 */
  private source: 'live' | 'simulated' = 'simulated';
  private lastError = '';

  constructor(
    private readonly store: CandleStoreService,
    private readonly registry: ExchangeRegistry,
    private readonly events: EventBusService,
  ) {}

  async onModuleInit() {
    for (const symbol of this.symbols) {
      await this.bootstrap(symbol);
    }
    this.startWebSocket();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.unsubscribeTicker?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  get isSimulated(): boolean {
    return this.source === 'simulated';
  }

  get status(): { source: 'live' | 'simulated'; wsConnected: boolean; lastError: string } {
    return { source: this.source, wsConnected: this.wsConnected, lastError: this.lastError };
  }

  // ------------------------------------------------------------------
  // 初始化：优先数据库历史 → 交易所 REST → 模拟数据
  // ------------------------------------------------------------------
  private async bootstrap(symbol: string) {
    for (const interval of TIMEFRAMES) {
      const history = await this.store.load(symbol, interval, HISTORY_COUNT[interval]);
      if (history.length > 0) {
        this.store.replaceAll(symbol, interval, history);
      }
    }

    const refreshed = await this.refreshFromExchange(symbol);
    if (refreshed) {
      this.source = 'live';
      this.lastError = '';
      return;
    }

    await this.startSimulation(symbol);
  }

  /** 尝试用公共 REST 补齐所有周期历史 */
  async refreshFromExchange(symbol: string): Promise<boolean> {
    for (const code of EXCHANGE_CODES) {
      try {
        const adapter = await this.registry.get(code);
        for (const interval of TIMEFRAMES) {
          const candles = await adapter.getKlines({
            symbol,
            interval,
            limit: HISTORY_COUNT[interval],
          });
          if (candles.length > 0) {
            this.store.replaceAll(symbol, interval, candles);
            await this.store.persistAll(symbol, interval);
          }
        }
        this.logger.log(`已从 ${code} 公共接口加载 ${symbol} 历史 K 线`);
        return true;
      } catch (err) {
        this.lastError = `${code} 行情拉取失败: ${(err as Error).message}`;
        this.logger.warn(this.lastError);
      }
    }
    return false;
  }

  private async startSimulation(symbol: string) {
    const feed = new SimulatedFeed(symbol);
    this.feeds.set(symbol, feed);
    for (const interval of TIMEFRAMES) {
      if (this.store.has(symbol, interval)) continue;
      const candles = feed.buildHistory(interval, HISTORY_COUNT[interval]);
      this.store.replaceAll(symbol, interval, candles);
      await this.store.persistAll(symbol, interval);
    }
    this.source = 'simulated';
    this.logger.warn(`外部行情不可达，${symbol} 已切换到模拟行情（决策与下单链路仍可完整运行）`);
  }

  // ------------------------------------------------------------------
  // WebSocket 实时行情
  // ------------------------------------------------------------------
  private startWebSocket() {
    const symbol = DEFAULT_SYMBOL;

    void this.registry.getPublic().then((adapter) => {
      const attachKlines = () => {
        this.unsubscribe?.();
        this.lastKlineAt = Date.now();
        this.unsubscribe = adapter.subscribeKlines(symbol, '1m', (candle) => {
          this.lastKlineAt = Date.now();
          this.wsConnected = true;
          this.source = 'live';
          this.applyCandle(symbol, '1m', candle);
        });
      };

      const attachTicker = () => {
        this.unsubscribeTicker?.();
        this.lastTickAt = Date.now();
        this.unsubscribeTicker = adapter.subscribeTicker(symbol, (quote) => {
          this.lastTickAt = Date.now();
          this.onLiveQuote(symbol, quote.price);
        });
      };

      try {
        attachKlines();
        attachTicker();
        this.logger.log(`已订阅 ${adapter.code} ${symbol} 1m K 线与最优报价流（秒级推送）`);
      } catch (err) {
        this.lastError = `行情订阅失败: ${(err as Error).message}`;
        this.logger.warn(this.lastError);
      }

      // 心跳式重连：两路流各自判定，任一路断掉只重连该路，互不影响
      this.reconnectTimer = setInterval(() => {
        const now = Date.now();
        const klineFresh = now - this.lastKlineAt < KLINE_STALE_MS;
        const tickFresh = now - this.lastTickAt < TICKER_STALE_MS;

        try {
          if (!klineFresh) {
            this.lastError = 'K 线流超时，正在重连';
            this.logger.warn(this.lastError);
            attachKlines();
          }
          if (!tickFresh) attachTicker();
        } catch (err) {
          this.lastError = `行情重连失败: ${(err as Error).message}`;
        }

        this.wsConnected = klineFresh || tickFresh;
      }, 15_000);
      if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    });
  }

  /**
   * 高频报价落地：记录最新价并让当前 K 线跟随，推送由 pushPrice 统一节流。
   * 1m K 线帧仍是权威数据（约 2s 一帧），这里只填补两帧之间的空白。
   */
  private onLiveQuote(symbol: string, price: number) {
    if (!(price > 0)) return;
    // 模拟行情下不接管价格，避免真实报价与模拟曲线混算
    if (this.source !== 'live') return;

    this.livePrices.set(symbol, { price, ts: Date.now() });

    // 刷新各周期当前 K 线，使图表与指标在两次 K 线帧之间也保持连续
    this.syncDerivedIntervals(symbol, price);

    this.pushPrice(symbol);
  }

  /**
   * 统一的价格推送出口，按秒节流。
   * K 线流与报价流都会触发，合并到同一出口避免两路流重复推送同一价格。
   */
  private pushPrice(symbol: string) {
    const now = Date.now();
    if (now - this.lastPricePushAt < PRICE_PUSH_INTERVAL_MS) return;
    this.lastPricePushAt = now;

    const ticker = this.getTicker(symbol);
    if (!(ticker.price > 0)) return;

    this.events.emit('price', {
      symbol,
      price: ticker.price,
      changePercent24h: ticker.changePercent24h,
      ts: now,
    });
  }

  /** 取有效的高频报价，过期返回 null 以回落到 K 线收盘价 */
  private getLivePrice(symbol: string): number | null {
    const live = this.livePrices.get(symbol);
    if (!live) return null;
    if (Date.now() - live.ts > LIVE_PRICE_TTL_MS) return null;
    return live.price;
  }

  private applyCandle(symbol: string, interval: Timeframe, candle: Candle) {
    const { closed, isNew } = this.store.upsert(symbol, interval, candle);
    if (isNew) {
      // 用最新价刷新更长周期的当前 K 线
      this.syncDerivedIntervals(symbol, candle.close);
    }
    if (closed) void this.store.flush();

    this.pushPrice(symbol);
    this.events.emit('candle', { symbol, interval, candle });
  }

  private syncDerivedIntervals(symbol: string, price: number) {
    for (const interval of TIMEFRAMES) {
      if (interval === '1m') continue;
      const rows = this.store.get(symbol, interval, HISTORY_COUNT[interval]);
      if (rows.length === 0) continue;
      const stepMs = TIMEFRAME_MS[interval];
      const openTime = Math.floor(Date.now() / stepMs) * stepMs;
      const last = rows[rows.length - 1];
      if (openTime > last.time) {
        const candle: Candle = {
          time: openTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
        };
        this.store.upsert(symbol, interval, candle);
      } else if (openTime === last.time) {
        this.store.upsert(symbol, interval, {
          ...last,
          close: price,
          high: Math.max(last.high, price),
          low: Math.min(last.low, price),
        });
      }
    }
  }

  /** 模拟行情心跳，由调度器每 5 秒调用一次 */
  pumpSimulation() {
    if (this.source !== 'simulated') return;
    for (const symbol of this.symbols) {
      const feed = this.feeds.get(symbol);
      if (!feed) continue;
      const price = feed.tick();

      for (const interval of TIMEFRAMES) {
        const rows = this.store.get(symbol, interval, HISTORY_COUNT[interval]);
        if (rows.length === 0) continue;
        const { candle, isNew } = feed.applyTick(price, rows, interval);
        const { closed } = this.store.upsert(symbol, interval, candle);
        if (isNew) this.events.emit('candle', { symbol, interval, candle });
        if (closed) void this.store.flush();
      }

      const ticker = this.getTicker(symbol);
      this.events.emit('price', {
        symbol,
        price: ticker.price,
        changePercent24h: ticker.changePercent24h,
        ts: Date.now(),
      });
    }
  }

  // ------------------------------------------------------------------
  // 读取接口
  // ------------------------------------------------------------------
  ensureSymbol(symbol: string) {
    if (this.symbols.has(symbol)) return;
    this.symbols.add(symbol);
    void this.bootstrap(symbol);
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  getCandles(symbol: string, interval: Timeframe, limit = 300): Candle[] {
    this.ensureSymbol(symbol);
    return this.store.get(symbol, interval, limit);
  }

  getTicker(symbol: string): Ticker {
    const candles = this.store.get(symbol, '1m', 1440);
    const sourceCandles = candles.length > 0 ? candles : this.store.get(symbol, '5m', 288);
    if (sourceCandles.length === 0) {
      return {
        symbol,
        price: 0,
        change24h: 0,
        changePercent24h: 0,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
        quoteVolume24h: 0,
        ts: Date.now(),
      };
    }

    // 有高频报价时以它为准，否则回落到最新 K 线收盘价
    const price = this.getLivePrice(symbol) ?? sourceCandles[sourceCandles.length - 1].close;
    const window = sourceCandles.slice(-1440);
    const open24h = window[0].open;
    // 实时价同样参与 24h 高低统计，避免盘口突破后高低值仍停留在上一根 K 线
    const high24h = Math.max(...window.map((c) => c.high), price);
    const low24h = Math.min(...window.map((c) => c.low), price);
    const volume24h = window.reduce((acc, c) => acc + c.volume, 0);
    const quoteVolume24h = window.reduce((acc, c) => acc + c.volume * c.close, 0);

    return {
      symbol,
      price,
      change24h: price - open24h,
      changePercent24h: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      high24h,
      low24h,
      volume24h,
      quoteVolume24h,
      ts: Date.now(),
    };
  }

  /** 今日市场整体动向 */
  getMarketPulse(symbol: string): MarketPulse {
    const ticker = this.getTicker(symbol);
    const hourly = this.store.get(symbol, '1h', 24 * 8);
    const closes = hourly.map((c) => c.close);
    const last24 = hourly.slice(-24);
    const previous = hourly.slice(-48, -24);

    // 日频波动率（不年化），便于前端直接展示“24h 波动率”
    const volatility24h = realizedVolatility(last24.map((c) => c.close), 24, false);
    const volume24 = last24.reduce((acc, c) => acc + c.volume, 0);
    const volumePrev = previous.reduce((acc, c) => acc + c.volume, 0);
    const volumeRatio = volumePrev > 0 ? volume24 / volumePrev : 1;

    const shortMa = average(closes.slice(-6));
    const longMa = average(closes.slice(-24));
    const trendScore = longMa > 0 ? ((shortMa - longMa) / longMa) * 100 : 0;

    const score = clamp(
      ticker.changePercent24h * 4 + trendScore * 25 + (ticker.price - ticker.low24h) / Math.max(ticker.high24h - ticker.low24h, 1) * 20 - 10,
      -100,
      100,
    );
    const sentiment: MarketPulse['sentiment'] =
      score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'neutral';

    return {
      symbol,
      price: ticker.price,
      changePercent24h: ticker.changePercent24h,
      high24h: ticker.high24h,
      low24h: ticker.low24h,
      volatility24h: Number.isFinite(volatility24h) ? volatility24h : 0,
      volumeRatio,
      candleCount: last24.length,
      sentiment,
      sentimentScore: Number(score.toFixed(2)),
      summary: buildSummary(ticker, sentiment, score, volumeRatio, volatility24h),
      updatedAt: Date.now(),
    };
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildSummary(
  ticker: Ticker,
  sentiment: MarketPulse['sentiment'],
  score: number,
  volumeRatio: number,
  volatility: number,
): string {
  const direction =
    sentiment === 'bullish' ? '偏强' : sentiment === 'bearish' ? '偏弱' : '多空胶着';
  const volumeWord = volumeRatio > 1.2 ? '明显放量' : volumeRatio < 0.8 ? '成交萎缩' : '量能平稳';
  const vol = Number.isFinite(volatility) ? `${volatility.toFixed(1)}%` : '统计中';
  return `BTC 现价 ${ticker.price.toFixed(2)}，24h ${ticker.changePercent24h >= 0 ? '+' : ''}${ticker.changePercent24h.toFixed(2)}%，市场情绪${direction}（分值 ${score.toFixed(0)}），${volumeWord}，24h 波动率约 ${vol}。`;
}
