import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  computeFuturesRoundTrips,
  computePosition,
  computeSpotRoundTrips,
  PositionFill,
  PositionSnapshot,
  RoundTripFill,
} from '@ai-trader/shared';
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

  /**
   * 回合盈亏：把「开仓 → 平仓」配对成一笔笔可展示的盈亏明细。
   *
   * 现货与合约分别用 computeSpotRoundTrips / computeFuturesRoundTrips，
   * 口径与各自持仓模型（computePosition / applyFuturesFill）严格一致——
   * 回合 netPnl 之和 === 持仓面板的 realizedPnl，两边不会对不上。
   *
   * @param market 市场类型（必传：现货/合约的成交不能混算）
   * @param symbol 可选过滤交易对；不传则汇总该市场全部
   */
  async getRoundTrips(market: 'spot' | 'futures', symbol?: string) {
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
      .andWhere('o.market = :market', { market })
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

    const { trips, summary } =
      market === 'futures' ? computeFuturesRoundTrips(fills) : computeSpotRoundTrips(fills);

    // 最近的回合排前面（前端列表按时间倒序展示更符合直觉）
    return {
      market,
      symbol: symbol ?? 'ALL',
      fillCount: fills.length,
      trips: [...trips].reverse(),
      summary,
    };
  }
}
