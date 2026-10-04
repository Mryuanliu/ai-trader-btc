import { DataSource } from 'typeorm';
import { MarketAggTradeEntity } from '../../database/entities/market-agg-trade.entity';
import { MarketFundingRateEntity } from '../../database/entities/market-funding-rate.entity';
import { MarketMarkPriceEntity } from '../../database/entities/market-mark-price.entity';
import { MarketSymbolMetaEntity } from '../../database/entities/market-symbol-meta.entity';
import { fundingSlotsInRange } from './history-pull';

/**
 * 回测启动前的数据质检（方案 A3 第 29 行 / CoinAPI 名言：
 * 「funding 缺失 → 纸面完美回测崩盘」）。
 *
 * 检查项（每项给 `pass/fail/skip`，fail 阻断 event-driven 回测）：
 * - meta:      是否已拉 symbol_meta（tickSize/stepSize 决定撮合精度）
 * - funding:   区间内 8h 结算槽覆盖率 ≥ 阈值（默认 99%）
 * - markPrice: 区间内 markPrice 覆盖密度（≥ 每分钟 1 条，容忍 5% 缺窗）
 * - aggTrade:  逐笔非空且时戳单调
 * - monotone:  时序单调（各表按 ts 主键排序）
 *
 * event-driven 引擎（A4）读它做前置门禁，不允许"无数据即回落 close 价"（A6 第 9 条）。
 */

export type QualityStatus = 'pass' | 'fail' | 'skip';

export interface QualityItem {
  key: string;
  status: QualityStatus;
  detail: string;
  value?: number;
  requirement?: string;
}

export interface QualityReport {
  ok: boolean;
  items: QualityItem[];
  symbol: string;
  from: number;
  to: number;
}

export interface QualityOptions {
  /** funding 覆盖率下限（0~1），默认 0.99 */
  fundingMinCoverage?: number;
  /** markPrice 每分钟最少条数（默认 0.95，容忍 5% 缺窗） */
  markPriceMinPerMinute?: number;
  /** 是否要求 aggTrades 就位；未拉 aggTrades 时可设为 false（skip） */
  requireAggTrades?: boolean;
}

/**
 * 时戳单调 + 首尾时间窗校验：
 * 返回 `{ monotone: true, count }` 或 `{ monotone: false, breakAt }`。
 */
async function checkMonotonic(
  rows: Array<Record<string, unknown>>,
  tsField: string,
): Promise<{ monotone: boolean; count: number; breakAt?: number }> {
  let prev = -Infinity;
  for (const r of rows) {
    const t = Number(r[tsField]);
    if (t < prev) return { monotone: false, count: rows.length, breakAt: t };
    prev = t;
  }
  return { monotone: true, count: rows.length };
}

export async function assertDataQuality(
  ds: DataSource,
  symbol: string,
  from: number,
  to: number,
  opts: QualityOptions = {},
): Promise<QualityReport> {
  const items: QualityItem[] = [];

  // 1. symbol meta
  const meta = await ds
    .getRepository(MarketSymbolMetaEntity)
    .findOne({ where: { symbol, market: 'futures' } });
  items.push({
    key: 'meta',
    status: meta ? 'pass' : 'fail',
    detail: meta
      ? `tickSize=${meta.tickSize}, stepSize=${meta.stepSize}, minNotional=${meta.minNotional}`
      : '未拉取 symbol_meta（撮合精度/维持保证金分层不可用）',
  });

  // 2. funding 覆盖
  const fundingRepo = ds.getRepository(MarketFundingRateEntity);
  const fundingRows: Array<Record<string, unknown>> = await fundingRepo
    .createQueryBuilder('f')
    .select('f.fundingTime', 'fundingTime')
    .where('f.symbol = :symbol', { symbol })
    .andWhere('f.fundingTime BETWEEN :from AND :to', { from, to })
    .orderBy('f.fundingTime', 'ASC')
    .getRawMany();
  const expectedSlots = fundingSlotsInRange(from, to);
  const fundingCov = expectedSlots > 0 ? fundingRows.length / expectedSlots : 0;
  const fundingMin = opts.fundingMinCoverage ?? 0.99;
  items.push({
    key: 'funding',
    status: fundingCov >= fundingMin ? 'pass' : 'fail',
    detail: `已入库 ${fundingRows.length} / 期望 ${expectedSlots}（覆盖 ${(fundingCov * 100).toFixed(2)}%，阈值 ${(fundingMin * 100).toFixed(0)}%）`,
    value: fundingCov,
    requirement: `coverage ≥ ${fundingMin}`,
  });
  const fundingMono = await checkMonotonic(fundingRows, 'fundingTime');
  items.push({
    key: 'funding.monotone',
    status: fundingMono.monotone ? 'pass' : 'fail',
    detail: fundingMono.monotone
      ? `${fundingMono.count} 条 fundingTime 单调`
      : `时序断裂 @ ${fundingMono.breakAt}`,
  });

  // 3. markPrice 覆盖
  const markRepo = ds.getRepository(MarketMarkPriceEntity);
  const markCount = await markRepo
    .createQueryBuilder('m')
    .where('m.symbol = :symbol', { symbol })
    .andWhere('m.market = :market', { market: 'futures' })
    .andWhere('m.ts BETWEEN :from AND :to', { from, to })
    .getCount();
  const minutes = Math.max(1, Math.floor((to - from) / 60_000));
  const markDensity = markCount / minutes;
  const markMin = opts.markPriceMinPerMinute ?? 0.95;
  items.push({
    key: 'markPrice',
    status: markDensity >= markMin ? 'pass' : 'fail',
    detail: `${markCount} 条 / ${minutes} 分钟 → 密度 ${markDensity.toFixed(3)}/min（阈值 ${markMin}）`,
    value: markDensity,
    requirement: `≥ ${markMin} per minute`,
  });

  // 4. aggTrades 存在性 + 单调
  if (opts.requireAggTrades !== false) {
    const aggs: Array<Record<string, unknown>> = await ds
      .getRepository(MarketAggTradeEntity)
      .createQueryBuilder('a')
      .select('a.tradeTime', 'tradeTime')
      .where('a.symbol = :symbol', { symbol })
      .andWhere('a.market = :market', { market: 'futures' })
      .andWhere('a.tradeTime BETWEEN :from AND :to', { from, to })
      .orderBy('a.tradeTime', 'ASC')
      .limit(200_000) // 单调只做前 20 万条抽样检查
      .getRawMany();
    const aggMono = await checkMonotonic(aggs, 'tradeTime');
    items.push({
      key: 'aggTrades',
      status: aggs.length > 0 && aggMono.monotone ? 'pass' : 'fail',
      detail: aggs.length === 0
        ? '区间内无 aggTrades（event-driven 引擎不可用）'
        : `${aggs.length} 条抽样，tradeTime ${aggMono.monotone ? '单调' : `断裂 @ ${aggMono.breakAt}`}`,
    });
  } else {
    items.push({ key: 'aggTrades', status: 'skip', detail: '未要求 aggTrades（vectorized 场景）' });
  }

  const ok = items.every((i) => i.status !== 'fail');
  return { ok, items, symbol, from, to };
}

/** 供 CLI/服务打印可读文本 */
export function formatQualityReport(r: QualityReport): string {
  const head = `数据质检 ${r.symbol} [${new Date(r.from).toISOString()} → ${new Date(r.to).toISOString()}]`;
  const body = r.items
    .map((i) => `  [${i.status.toUpperCase().padEnd(4)}] ${i.key.padEnd(20)} ${i.detail}`)
    .join('\n');
  return `${head}\n${body}\n  → ${r.ok ? 'PASS' : 'FAIL'}`;
}
