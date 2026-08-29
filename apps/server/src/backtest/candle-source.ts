import { Repository } from 'typeorm';
import { Candle } from '@ai-trader/shared';
import { MarketCandleEntity } from '../database/entities';
import { BinanceAdapter } from '../exchanges/binance.adapter';
import type { Timeframe } from '@ai-trader/shared';

/**
 * 回测数据源：区间加载与历史回填。
 *
 * 不复用 CandleStoreService.load()（take+ASC 只能取到最早的 N 条），
 * 这里自建区间查询；backfill 用 Binance 公共 REST 分页拉取后 upsert 落库。
 */
export async function loadRange(
  repo: Repository<MarketCandleEntity>,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
): Promise<Candle[]> {
  const rows = await repo
    .createQueryBuilder('c')
    .where('c.symbol = :symbol AND c.interval = :interval', { symbol, interval })
    .andWhere('c.openTime >= :from AND c.openTime <= :to', { from, to })
    .orderBy('c.openTime', 'ASC')
    .getMany();

  return rows.map((row) => ({
    time: Number(row.openTime),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

/** 从交易所回填历史 K 线（公共 REST，无需密钥），返回本次新插入的根数 */
export async function backfill(
  repo: Repository<MarketCandleEntity>,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
): Promise<number> {
  const adapter = new BinanceAdapter('live', '', '');
  const stepMs = intervalStepMs(interval);
  let inserted = 0;
  let cursor = from;

  while (cursor < to) {
    const batch = await adapter.getKlines({
      symbol,
      interval,
      startTime: cursor,
      endTime: to,
      limit: 1000,
    });
    if (batch.length === 0) break;

    await repo
      .createQueryBuilder()
      .insert()
      .into(MarketCandleEntity)
      .values(
        batch.map((c) => ({
          symbol,
          interval,
          openTime: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
      )
      .orIgnore()
      .execute();

    inserted += batch.length;
    const lastTime = batch.at(-1)!.time;
    if (lastTime <= cursor) break; // 防御：交易所返回未推进则退出
    cursor = lastTime + stepMs;
  }

  return inserted;
}

function intervalStepMs(interval: Timeframe): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 300_000;
  const n = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 60_000;
  return n * unitMs;
}
