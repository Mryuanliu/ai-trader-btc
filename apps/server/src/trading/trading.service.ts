import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  MarketType,
  OrderDTO,
  OrderSource,
  OrderStatus,
  PageResult,
} from '@ai-trader/shared';
import { In, Repository } from 'typeorm';
import { OrderEntity, TradeFillEntity } from '../database/entities';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { EventBusService } from '../common/events';
import { BusinessException } from '../common/business.exception';
import { normalizePagination, toPageResult } from '../common/pagination';

/**
 * 订单记录服务（跨市场共用 orders/trade_fills 表的唯一读取出口）。
 *
 * 仅合约模式下本服务不再承担下单职责——合约下单走 `FuturesTradingService`
 * （方向语义/杠杆/保证金/强平风控都在那边），这里只保留：
 * 订单查询、状态同步、撤单、成交明细与今日统计。
 */
@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(TradeFillEntity)
    private readonly fillRepo: Repository<TradeFillEntity>,
    private readonly registry: ExchangeRegistry,
    private readonly events: EventBusService,
  ) {}

  toDTO(order: OrderEntity): OrderDTO {
    return {
      id: order.id,
      exchange: order.exchange,
      environment: order.environment,
      mode: order.mode,
      market: order.market,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      stopPrice: Number(order.stopPrice ?? 0),
      quantity: order.quantity,
      quoteAmount: order.quoteAmount,
      status: order.status,
      filledQuantity: order.filledQuantity,
      filledPrice: order.filledPrice,
      exchangeOrderId: order.exchangeOrderId,
      source: order.source,
      error: order.error,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  async list(params: {
    page?: number;
    pageSize?: number;
    status?: OrderStatus;
    symbol?: string;
    source?: OrderSource;
    /** 市场过滤。历史数据里仍有 market='spot' 的行（保留作审计），查询必须显式指定 */
    market?: MarketType;
  }): Promise<PageResult<OrderDTO>> {
    const { page, pageSize, skip, take } = normalizePagination(params);
    const qb = this.orderRepo.createQueryBuilder('o');
    if (params.status) qb.andWhere('o.status = :status', { status: params.status });
    if (params.symbol) qb.andWhere('o.symbol = :symbol', { symbol: params.symbol });
    if (params.source) qb.andWhere('o.source = :source', { source: params.source });
    if (params.market) qb.andWhere('o.market = :market', { market: params.market });
    qb.orderBy('o.createdAt', 'DESC').skip(skip).take(take);

    const [rows, total] = await qb.getManyAndCount();
    return toPageResult(rows.map((r) => this.toDTO(r)), total, page, pageSize);
  }

  async recent(limit = 10, market?: MarketType): Promise<OrderDTO[]> {
    const rows = await this.orderRepo.find({
      where: market ? { market } : undefined,
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => this.toDTO(r));
  }

  /**
   * 今日订单统计。
   *
   * 必须按 market 分组：orders 表是历史双市场共用表，
   * 存量现货单仍在库内，不隔离会把旧现货单量算进今日合约口径。
   */
  async statsToday(): Promise<{
    filled: number;
    open: number;
    byMarket: Record<'spot' | 'futures', { filled: number; open: number }>;
  }> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const openStatuses = ['NEW', 'PARTIALLY_FILLED'];

    const count = async (market: 'spot' | 'futures') => {
      const filled = await this.orderRepo
        .createQueryBuilder('o')
        .where('o."createdAt" >= :start', { start })
        .andWhere('o.status = :status', { status: 'FILLED' })
        .andWhere('o.market = :market', { market })
        .getCount();
      const open = await this.orderRepo
        .createQueryBuilder('o')
        .where('o.status IN (:...statuses)', { statuses: openStatuses })
        .andWhere('o.market = :market', { market })
        .getCount();
      return { filled, open };
    };

    const [spot, futures] = await Promise.all([count('spot'), count('futures')]);
    return {
      // 仅合约模式下顶层字段改用合约口径（现货分支仅为兼容历史快照结构保留）
      filled: futures.filled,
      open: futures.open,
      byMarket: { spot, futures },
    };
  }
}
