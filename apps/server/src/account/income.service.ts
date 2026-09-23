import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExchangeIncomeEntity } from '../database/entities/exchange-income.entity';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { isFuturesAdapter } from '../exchanges/adapter.interface';

/** 合约交易所标识（与 FuturesTradingService 保持一致的唯一合约通道） */
const FUTURES_EXCHANGE = 'binance-futures' as const;

/** 资金流水分类汇总（交易所口径） */
export interface IncomeSummary {
  /** 平仓已实现盈亏（基于实际成交价，已含滑点） */
  realizedPnl: number;
  /** 手续费（开仓 + 平仓，通常为负） */
  commission: number;
  /** 资金费 / 持仓费用（可正可负） */
  fundingFee: number;
  /** 其他流水（保险金、强平等） */
  other: number;
  /** 净额 = 以上之和 —— 这就是账户真实到账的盈亏 */
  net: number;
  /** 参与汇总的流水条数 */
  count: number;
}

/**
 * 交易所资金流水服务。
 *
 * 存在的意义：**让平台盈亏与交易所真实到账对齐**。
 *
 * 只按成交（fill）算盈亏会漏掉资金费——它每 8 小时独立结算、不产生成交，
 * 因此「今日盈亏」和「篮子盈亏」都会与账户实际变动差一截，且两者还会互相对不上。
 * 权威口径是 income 的 `REALIZED_PNL + COMMISSION + FUNDING_FEE` 之和。
 */
@Injectable()
export class IncomeService {
  private readonly logger = new Logger(IncomeService.name);

  constructor(
    @InjectRepository(ExchangeIncomeEntity)
    private readonly repo: Repository<ExchangeIncomeEntity>,
    private readonly registry: ExchangeRegistry,
  ) {}

  /**
   * 从交易所拉取资金流水并落库。
   *
   * `tranId` 有唯一索引，重复拉取不会重复记账，所以可以放心地按固定窗口反复同步
   * （采用「拉最近 N 小时」的滚动窗口，天然覆盖延迟入账的流水）。
   */
  async sync(hours = 24): Promise<{ fetched: number; inserted: number }> {
    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    if (!isFuturesAdapter(adapter)) return { fetched: 0, inserted: 0 };

    const startTime = Date.now() - hours * 60 * 60 * 1000;
    const rows = await adapter.getIncome({ startTime, limit: 1000 });
    if (rows.length === 0) return { fetched: 0, inserted: 0 };

    // 已存在的 tranId 先批量查出来，避免逐条 findOne
    const incoming = rows.map((r) => r.tranId);
    const existing = await this.repo
      .createQueryBuilder('i')
      .select('i.tranId', 'tranId')
      .where('i.tranId IN (:...ids)', { ids: incoming })
      .getRawMany<{ tranId: string }>();
    const known = new Set(existing.map((e) => e.tranId));

    const fresh = rows.filter((r) => !known.has(r.tranId));
    if (fresh.length > 0) {
      await this.repo.save(
        fresh.map((r) =>
          this.repo.create({
            tranId: r.tranId,
            incomeType: r.incomeType,
            symbol: r.symbol ?? '',
            asset: r.asset ?? 'USDT',
            amount: r.amount,
            time: new Date(r.time),
          }),
        ),
      );
    }

    if (fresh.length > 0) {
      this.logger.log(`资金流水同步：拉到 ${rows.length} 条，新增 ${fresh.length} 条`);
    }
    return { fetched: rows.length, inserted: fresh.length };
  }

  /** 按类型汇总指定区间 / 交易对的资金流水（交易所权威口径） */
  async summary(params: { symbol?: string; from?: Date; to?: Date } = {}): Promise<IncomeSummary> {
    const qb = this.repo
      .createQueryBuilder('i')
      .select('i.incomeType', 'type')
      .addSelect('SUM(i.amount)', 'total')
      .addSelect('COUNT(*)', 'cnt')
      .groupBy('i.incomeType');
    if (params.symbol) qb.andWhere('i.symbol = :symbol', { symbol: params.symbol });
    if (params.from) qb.andWhere('i.time >= :from', { from: params.from });
    if (params.to) qb.andWhere('i.time <= :to', { to: params.to });

    const rows = await qb.getRawMany<{ type: string; total: string; cnt: string }>();

    const result: IncomeSummary = {
      realizedPnl: 0,
      commission: 0,
      fundingFee: 0,
      other: 0,
      net: 0,
      count: 0,
    };
    for (const r of rows) {
      const total = Number(r.total) || 0;
      result.count += Number(r.cnt) || 0;
      if (r.type === 'REALIZED_PNL') result.realizedPnl += total;
      else if (r.type === 'COMMISSION') result.commission += total;
      else if (r.type === 'FUNDING_FEE') result.fundingFee += total;
      else result.other += total;
    }
    result.net = result.realizedPnl + result.commission + result.fundingFee + result.other;
    return result;
  }

  /** 只取资金费（篮子结算常用） */
  async fundingFeeBetween(symbol: string, from: Date, to: Date): Promise<number> {
    const s = await this.summary({ symbol, from, to });
    return Number(s.fundingFee.toFixed(8));
  }
}
