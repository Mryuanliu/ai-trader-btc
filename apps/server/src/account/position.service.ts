import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  computeFuturesRoundTrips,
  PositionFill,
  RoundTripFill,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { TradeFillEntity } from '../database/entities';

/**
 * 单次推导最多读取的成交明细条数。
 * 超出后从最早记录截断并告警，避免长期运行后单次查询拖慢主链路。
 */
const MAX_FILLS = 10_000;

interface FillRow extends PositionFill {
  filledAt: Date;
}

/**
 * 回合盈亏服务（合约口径）。
 *
 * 把「开仓 → 平仓」配对成一笔笔可展示的盈亏明细，用 shared 的
 * computeFuturesRoundTrips，与合约持仓模型（applyFuturesFill）严格一致——
 * 回合 netPnl 之和 === 合约持仓 realizedPnl，两边不会对不上。
 *
 * 原 `getPosition`（现货持仓推导，computePosition）已随现货链路移除；
 * 合约持仓以交易所 positionRisk 为权威（FuturesPositionService），不由成交推导。
 */
@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(TradeFillEntity)
    private readonly fillRepo: Repository<TradeFillEntity>,
  ) {}

  /**
   * 回合盈亏（合约）。
   *
   * @param symbol 可选过滤交易对；不传则汇总全部
   */
  async getRoundTrips(symbol?: string) {
    const rows = await this.fillRepo
      .createQueryBuilder('f')
      .innerJoin('orders', 'o', 'o.id::text = f."orderId"')
      .select('o.side', 'side')
      .addSelect('f.quantity', 'quantity')
      .addSelect('f.price', 'price')
      .addSelect('f.fee', 'fee')
      .addSelect('f."filledAt"', 'filledAt')
      .addSelect('f."orderId"', 'orderId')
      .where('o.id::text = f."orderId"')
      // 只统计已成交（FILLED / PARTIALLY_FILLED）的订单，未成交与已撤销不计入
      .andWhere('o.status IN (:...statuses)', { statuses: ['FILLED', 'PARTIALLY_FILLED'] })
      .andWhere(symbol ? 'f.symbol = :symbol' : '1=1', symbol ? { symbol } : {})
      .orderBy('f."filledAt"', 'ASC')
      .addOrderBy('f.id', 'ASC')
      .take(MAX_FILLS)
      .getRawMany<FillRow & { orderId: string }>();

    const fills: RoundTripFill[] = rows.map((r) => ({
      side: r.side,
      quantity: Number(r.quantity),
      price: Number(r.price),
      fee: Number(r.fee) || 0,
      time: new Date(r.filledAt).getTime(),
      orderId: r.orderId,
    }));

    const { trips, summary } = computeFuturesRoundTrips(fills);

    // 最近的回合排前面（前端列表按时间倒序展示更符合直觉）
    return {
      market: 'futures' as const,
      symbol: symbol ?? 'ALL',
      fillCount: fills.length,
      trips: [...trips].reverse(),
      summary,
    };
  }
}
