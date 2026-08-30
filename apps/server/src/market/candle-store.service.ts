import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Candle, DEFAULT_MARKET, MarketType, Timeframe } from '@ai-trader/shared';
import { In, Repository } from 'typeorm';
import { MarketCandleEntity } from '../database/entities';

const MAX_BUFFER = 1500;

/**
 * 内存缓冲键纳入 market：现货与合约同标的 K 线必须分开缓存，
 * 否则合约行情会覆盖现货缓冲，污染现货指标与回测。
 */
function key(symbol: string, interval: Timeframe, market: MarketType): string {
  return `${market}:${symbol}:${interval}`;
}

/**
 * K 线缓冲：内存环形数组 + 批量落库
 * 逐 tick 只更新内存，K 线闭合时才写库，避免高频写入
 */
@Injectable()
export class CandleStoreService {
  private readonly logger = new Logger(CandleStoreService.name);
  private readonly buffers = new Map<string, Candle[]>();
  private readonly pending = new Map<string, Candle>();

  constructor(
    @InjectRepository(MarketCandleEntity)
    private readonly repo: Repository<MarketCandleEntity>,
  ) {}

  get(symbol: string, interval: Timeframe, limit = 300, market: MarketType = DEFAULT_MARKET): Candle[] {
    const rows = this.buffers.get(key(symbol, interval, market)) ?? [];
    return rows.slice(-limit);
  }

  has(symbol: string, interval: Timeframe, market: MarketType = DEFAULT_MARKET): boolean {
    return (this.buffers.get(key(symbol, interval, market))?.length ?? 0) > 0;
  }

  /** 写入一根 K 线（同 openTime 覆盖，新的追加），返回是否闭合了新周期 */
  upsert(
    symbol: string,
    interval: Timeframe,
    candle: Candle,
    market: MarketType = DEFAULT_MARKET,
  ): { closed: boolean; isNew: boolean } {
    const k = key(symbol, interval, market);
    let rows = this.buffers.get(k);
    if (!rows) {
      rows = [];
      this.buffers.set(k, rows);
    }
    const last = rows[rows.length - 1];
    let isNew = false;
    if (last && last.time === candle.time) {
      rows[rows.length - 1] = candle;
    } else if (!last || candle.time > last.time) {
      rows.push(candle);
      isNew = true;
      if (rows.length > MAX_BUFFER) rows.splice(0, rows.length - MAX_BUFFER);
    } else {
      // 过期数据，忽略
      return { closed: false, isNew: false };
    }
    if (isNew && last) {
      this.pending.set(k, last);
      return { closed: true, isNew };
    }
    return { closed: false, isNew };
  }

  replaceAll(
    symbol: string,
    interval: Timeframe,
    candles: Candle[],
    market: MarketType = DEFAULT_MARKET,
  ) {
    this.buffers.set(
      key(symbol, interval, market),
      candles.slice(-MAX_BUFFER).sort((a, b) => a.time - b.time),
    );
  }

  /** 批量落库（ON CONFLICT 覆盖同一 openTime） */
  async flush(): Promise<number> {
    if (this.pending.size === 0) return 0;
    const entries = [...this.pending.entries()];
    this.pending.clear();

    const rows: Partial<MarketCandleEntity>[] = [];
    for (const [k, candle] of entries) {
      // key 形如 `market:symbol:interval`
      const [market, symbol, interval] = k.split(':');
      rows.push({
        symbol,
        market: market as MarketType,
        interval: interval as Timeframe,
        openTime: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
    }
    try {
      // 冲突键必须与唯一索引 (symbol, market, interval, openTime) 一致，
      // 否则合约 K 线写入会与现货互相覆盖
      await this.repo.upsert(rows, ['symbol', 'market', 'interval', 'openTime']);
      return rows.length;
    } catch (err) {
      this.logger.error(`K 线落库失败: ${(err as Error).message}`);
      return 0;
    }
  }

  async persistAll(
    symbol: string,
    interval: Timeframe,
    market: MarketType = DEFAULT_MARKET,
  ) {
    const candles = this.get(symbol, interval, MAX_BUFFER, market);
    if (candles.length === 0) return;
    const rows = candles.map((c) => ({
      symbol,
      market,
      interval,
      openTime: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    try {
      await this.repo.upsert(rows, ['symbol', 'market', 'interval', 'openTime']);
    } catch (err) {
      this.logger.error(`K 线全量落库失败: ${(err as Error).message}`);
    }
  }

  /** 从数据库装载历史 K 线 */
  async load(
    symbol: string,
    interval: Timeframe,
    limit = 300,
    market: MarketType = DEFAULT_MARKET,
  ): Promise<Candle[]> {
    const rows = await this.repo.find({
      where: { symbol, interval, market },
      order: { openTime: 'ASC' },
      take: limit,
    });
    return rows.map((r) => ({
      time: Number(r.openTime),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  async count(
    symbol: string,
    interval: Timeframe,
    market: MarketType = DEFAULT_MARKET,
  ): Promise<number> {
    return this.repo.count({ where: { symbol, interval, market } });
  }

  async clear(symbol: string, interval: Timeframe, market: MarketType = DEFAULT_MARKET) {
    await this.repo.delete({ symbol, interval, market });
    this.buffers.delete(key(symbol, interval, market));
  }

  async deleteSymbols(symbols: string[]) {
    if (symbols.length === 0) return;
    await this.repo.delete({ symbol: In(symbols) });
  }
}
