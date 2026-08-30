import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { computePosition, PositionFill, PositionSnapshot } from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { TradeFillEntity } from '../database/entities';
import { MarketService } from '../market/market.service';

/**
 * 单次推导最多读取的成交明细条数。
 * 按默认 maxDailyOrders=20 计算，可覆盖约一年；超出后从最早记录截断并告警，
 * 避免长期运行后单次查询拖慢决策主链路。
 */
const MAX_FILLS = 10_000;

interface FillRow extends PositionFill {
  filledAt: Date;
}

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(TradeFillEntity)
    private readonly fillRepo: Repository<TradeFillEntity>,
    private readonly market: MarketService,
  ) {}

  /**
   * 由成交明细推导**现货**持仓。
   *
   * trade_fills 自身不含买卖方向，需与 orders 关联取 side。
   * 只统计已成交（FILLED / PARTIALLY_FILLED）的订单，未成交与已撤销不计入。
   *
   * 必须限定 o.market='spot'：现货与合约共用 orders/trade_fills 两张表，
   * 同标的（BTCUSDT）的合约成交若混入，会凭空推导出一个不存在的现货持仓，
   * 进而污染现货敞口风控与止损止盈判定。合约持仓请以交易所 positionRisk 为准。
   */
  async getPosition(symbol: string): Promise<PositionSnapshot> {
    this.market.ensureSymbol(symbol);
    const currentPrice = this.market.getTicker(symbol).price || 0;

    const rows = await this.fillRepo
      .createQueryBuilder('f')
      .innerJoin('orders', 'o', 'o.id::text = f."orderId"')
      .select('o.side', 'side')
      .addSelect('f.quantity', 'quantity')
      .addSelect('f.price', 'price')
      .addSelect('f.fee', 'fee')
      .addSelect('f."filledAt"', 'filledAt')
      // orders.id 是 uuid 而 fills.orderId 是 varchar，必须显式转型后才能关联
      .where('o.id::text = f."orderId"')
      .andWhere('f.symbol = :symbol', { symbol })
      .andWhere('o.market = :market', { market: 'spot' })
      .andWhere('o.status IN (:...statuses)', {
        statuses: ['FILLED', 'PARTIALLY_FILLED'],
      })
      .orderBy('f."filledAt"', 'ASC')
      .addOrderBy('f.id', 'ASC')
      .take(MAX_FILLS)
      .getRawMany<FillRow>();

    if (rows.length >= MAX_FILLS) {
      this.logger.warn(
        `${symbol} 成交明细达到 ${MAX_FILLS} 条上限，持仓成本价可能不完整，建议归档历史成交`,
      );
    }

    return computePosition(symbol, rows, currentPrice);
  }
}
