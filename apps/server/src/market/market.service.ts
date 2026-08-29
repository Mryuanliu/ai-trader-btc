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

@Injectable()
export class MarketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketService.name);
  private readonly symbols = new Set<string>([DEFAULT_SYMBOL]);
  private readonly feeds = new Map<string, SimulatedFeed>();
  private unsubscribe: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wsConnected = false;

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
    const adapterPromise = this.registry.getPublic();

    void adapterPromise.then((adapter) => {
      const attach = () => {
        this.unsubscribe = adapter.subscribeKlines(symbol, '1m', (candle) => {
          this.wsConnected = true;
          this.source = 'live';
          this.applyCandle(symbol, '1m', candle);
        });
        this.logger.log(`已订阅 ${adapter.code} ${symbol} 1m 实时行情`);
      };

      try {
        attach();
        // 简易重连：每 60s 检查一次，断了就重连
        this.reconnectTimer = setInterval(() => {
          if (this.source === 'simulated') {
            try {
              this.unsubscribe?.();
              attach();
            } catch (err) {
              this.lastError = `行情重连失败: ${(err as Error).message}`;
            }
          }
        }, 60_000);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
      } catch (err) {
        this.lastError = `行情订阅失败: ${(err as Error).message}`;
        this.logger.warn(this.lastError);
      }
    });
  }

  private applyCandle(symbol: string, interval: Timeframe, candle: Candle) {
    const { closed, isNew } = this.store.upsert(symbol, interval, candle);
    if (isNew) {
      // 用最新价刷新更长周期的当前 K 线
      this.syncDerivedIntervals(symbol, candle.close);
    }
    if (closed) void this.store.flush();

    const ticker = this.getTicker(symbol);
    this.events.emit('price', {
      symbol,
      price: ticker.price,
      changePercent24h: ticker.changePercent24h,
      ts: Date.now(),
    });
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

    const price = sourceCandles[sourceCandles.length - 1].close;
    const window = sourceCandles.slice(-1440);
    const open24h = window[0].open;
    const high24h = Math.max(...window.map((c) => c.high));
    const low24h = Math.min(...window.map((c) => c.low));
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
