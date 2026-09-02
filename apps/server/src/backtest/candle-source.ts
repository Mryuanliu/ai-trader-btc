import { Repository } from 'typeorm';
import { Candle, FundingRate, MarketType } from '@ai-trader/shared';
import { FundingRateEntity, MarketCandleEntity } from '../database/entities';
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.adapter';
import type { Timeframe } from '@ai-trader/shared';

/**
 * 回测数据源：区间加载与历史回填。
 *
 * 不复用 CandleStoreService.load()（take+ASC 只能取到最早的 N 条），
 * 这里自建区间查询；backfill 用交易所公共 REST 分页拉取后落库。
 *
 * **必须按 market 维度查询与写入**：现货与合约同标的的 K 线价格存在基差，
 * 混存会让合约回测用现货价格、现货回测被合约价格污染。
 */
export async function loadRange(
  repo: Repository<MarketCandleEntity>,
  symbol: string,
  interval: Timeframe,
  from: number,
  to: number,
  market: MarketType = 'futures',
): Promise<Candle[]> {
  const rows = await repo
    .createQueryBuilder('c')
    .where('c.symbol = :symbol AND c.interval = :interval', { symbol, interval })
    .andWhere('c.market = :market', { market })
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
  market: MarketType = 'futures',
  onProgress?: (fetched: number, expected: number) => void,
): Promise<number> {
  // 仅合约模式：K 线一律走 fapi 公共 REST（无需密钥）
  const adapter = new BinanceFuturesAdapter('live', '', '');
  const stepMs = intervalStepMs(interval);
  let inserted = 0;
  let cursor = from;

  const expectedTotal = Math.max(1, Math.floor((to - from) / stepMs) + 1);
  let fetchedTotal = 0;
  while (cursor < to) {
    // 代理链路偶发 ECONNRESET：单批重试而不是让整个回填失败（此前一批失败即全盘报废）
    let batch: Candle[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        batch = await adapter.getKlines({
          symbol,
          interval,
          startTime: cursor,
          endTime: to,
          limit: 1000,
        });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!batch || batch.length === 0) break;

    await repo
      .createQueryBuilder()
      .insert()
      .into(MarketCandleEntity)
      .values(
        batch.map((c) => ({
          symbol,
          market,
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
    fetchedTotal += batch.length;
    onProgress?.(Math.min(fetchedTotal, expectedTotal), expectedTotal);
    const lastTime = batch.at(-1)!.time;
    if (lastTime <= cursor) break; // 防御：交易所返回未推进则退出
    cursor = lastTime + stepMs;
  }

  return inserted;
}

/** 加载区间内的资金费率（按结算时间升序），供合约回测计费 */
export async function loadFundingRange(
  repo: Repository<FundingRateEntity>,
  symbol: string,
  from: number,
  to: number,
): Promise<{ fundingTime: number; rate: number }[]> {
  const rows = await repo
    .createQueryBuilder('f')
    .where('f.symbol = :symbol', { symbol })
    .andWhere('f.fundingTime >= :from AND f.fundingTime <= :to', { from, to })
    .orderBy('f.fundingTime', 'ASC')
    .getMany();

  return rows.map((r) => ({ fundingTime: Number(r.fundingTime), rate: r.rate }));
}

/**
 * 回填资金费率（公共 REST，无需密钥）。
 * /fapi/v1/fundingRate 单次最多 1000 条，按 startTime 分页拉取。
 */
export async function backfillFunding(
  repo: Repository<FundingRateEntity>,
  symbol: string,
  from: number,
  to: number,
  onProgress?: (fetched: number) => void,
): Promise<number> {
  const adapter = new BinanceFuturesAdapter('live', '', '');
  let inserted = 0;
  let cursor = from;
  let fetchedTotal = 0;

  while (cursor < to) {
    let batch: FundingRate[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        batch = await adapter.getFundingRates(symbol, 1000);
        // 只保留区间内的部分；接口按时间倒序返回
        batch = batch
          .filter((r) => r.fundingTime >= cursor && r.fundingTime <= to)
          .sort((a, b) => a.fundingTime - b.fundingTime);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!batch || batch.length === 0) break;

    await repo
      .createQueryBuilder()
      .insert()
      .into(FundingRateEntity)
      .values(
        batch.map((r) => ({
          symbol: r.symbol,
          fundingTime: r.fundingTime,
          rate: r.rate,
          markPrice: r.markPrice ?? null,
        })),
      )
      .orIgnore()
      .execute();

    inserted += batch.length;
    fetchedTotal += batch.length;
    onProgress?.(fetchedTotal);
    const lastTime = batch.at(-1)!.fundingTime;
    if (lastTime <= cursor) break;
    cursor = lastTime + 8 * 3_600_000; // 资金费每 8h 结算一次
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
