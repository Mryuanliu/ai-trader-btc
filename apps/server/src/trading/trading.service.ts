import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DEFAULT_SYMBOL,
  ExchangeCode,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
  PageResult,
  RunMode,
} from '@ai-trader/shared';
import { In, Repository } from 'typeorm';
import { OrderEntity, TradeFillEntity } from '../database/entities';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { MarketService } from '../market/market.service';
import { EventBusService } from '../common/events';
import { RiskService } from './risk.service';
import { AccountService } from '../account/account.service';
import { BusinessException } from '../common/business.exception';
import { normalizePagination, toPageResult } from '../common/pagination';
import { AgentConfigService } from '../agent/agent-config.service';

export interface PlaceOrderInput {
  exchange?: ExchangeCode;
  symbol?: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  source: OrderSource;
  decisionId?: string | null;
  confirmToken?: string;
  /** 跳过风控（仅内部补偿使用，正常链路禁止） */
  skipRisk?: boolean;
}

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(TradeFillEntity)
    private readonly fillRepo: Repository<TradeFillEntity>,
    private readonly registry: ExchangeRegistry,
    private readonly market: MarketService,
    private readonly events: EventBusService,
    private readonly risk: RiskService,
    private readonly accounts: AccountService,
    private readonly agentConfig: AgentConfigService,
    private readonly config: ConfigService,
  ) {}

  toDTO(order: OrderEntity): OrderDTO {
    return {
      id: order.id,
      exchange: order.exchange,
      environment: order.environment,
      mode: order.mode,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      quantity: order.quantity,
      quoteAmount: order.quoteAmount,
      status: order.status,
      filledQuantity: order.filledQuantity,
      filledPrice: order.filledPrice,
      exchangeOrderId: order.exchangeOrderId,
      source: order.source,
      decisionId: order.decisionId,
      error: order.error,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderDTO> {
    const agentConfig = await this.agentConfig.getOrCreate();
    const config = this.agentConfig.toShape(agentConfig);
    const symbol = input.symbol ?? config.symbol ?? DEFAULT_SYMBOL;
    const mode: RunMode = config.mode;
    const exchange: ExchangeCode = input.exchange ?? config.enabledExchanges?.[0] ?? 'binance';

    this.market.ensureSymbol(symbol);
    const ticker = this.market.getTicker(symbol);
    const price = input.type === 'LIMIT' && input.price ? input.price : ticker.price || 0;
    if (!(price > 0)) {
      throw new BusinessException('EXCHANGE_ERROR', '无法获取当前价格，下单已取消');
    }

    const quantity = Number(input.quantity);
    if (!(quantity > 0)) {
      throw new BusinessException('BAD_REQUEST', '下单数量必须大于 0');
    }

    const quoteAmount = price * quantity;

    // ---- 风控前置（自动单与手动单统一） ----
    let riskVerdict: { passed: boolean; rejectedBy?: string; note?: string } = {
      passed: true,
      note: '未启用风控校验',
    };
    if (!input.skipRisk) {
      const balances = await this.accounts.getBalances(mode, config.enabledExchanges);
      const quoteFree = sumAsset(balances.rows, 'USDT');
      const baseFree = sumAsset(balances.rows, 'BTC');
      riskVerdict = await this.risk.check({
        config,
        symbol,
        side: input.side,
        quantity,
        price,
        quoteAmount,
        quoteFree,
        baseFree,
        quoteSource: balances.source,
        source: input.source,
        confirmToken: input.confirmToken,
        liveConfirmToken: this.config.get<string>('LIVE_TRADING_CONFIRM_TOKEN', ''),
      });
      if (!riskVerdict.passed) {
        await this.risk.record(
          'reject',
          'warn',
          `${input.side} ${symbol} 被风控拦截：${riskVerdict.note}`,
          symbol,
          input.decisionId ?? null,
        );
        throw new BusinessException('RISK_REJECTED', riskVerdict.note ?? '风控拦截');
      }
    }

    const clientOrderId = `at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const environment = mode === 'live' ? 'live' : 'testnet';

    let order = this.orderRepo.create({
      exchange,
      environment,
      mode,
      symbol,
      side: input.side,
      type: input.type,
      price,
      quantity,
      quoteAmount,
      status: 'NEW',
      clientOrderId,
      source: input.source,
      decisionId: input.decisionId ?? null,
    });
    order = await this.orderRepo.save(order);

    if (mode === 'dry_run') {
      order.status = 'FILLED';
      order.filledQuantity = quantity;
      order.filledPrice = price;
      order.exchangeOrderId = `DRY_${order.id.slice(0, 8)}`;
      order = await this.orderRepo.save(order);
      await this.fillRepo.save(
        this.fillRepo.create({
          orderId: order.id,
          symbol,
          price,
          quantity,
          fee: quoteAmount * 0.001,
          feeAsset: 'USDT',
          filledAt: new Date(),
        }),
      );
      this.logger.log(`[dry-run] ${input.side} ${quantity} ${symbol} @ ${price}`);
    } else {
      try {
        const adapter = await this.registry.get(exchange);
        const result = await adapter.placeOrder({
          symbol,
          side: input.side,
          type: input.type,
          quantity,
          price: input.type === 'LIMIT' ? price : undefined,
          clientOrderId,
        });
        order.exchangeOrderId = result.exchangeOrderId;
        order.status = result.status;
        order.filledQuantity = result.filledQuantity;
        order.filledPrice = result.filledPrice;
        order.error = null;
        order = await this.orderRepo.save(order);

        if (result.filledQuantity > 0) {
          await this.fillRepo.save(
            this.fillRepo.create({
              orderId: order.id,
              symbol,
              price: result.filledPrice || price,
              quantity: result.filledQuantity,
              fee: 0,
              feeAsset: 'USDT',
              filledAt: new Date(),
            }),
          );
        }
        this.logger.log(
          `[${mode}] ${input.side} ${quantity} ${symbol} @ ${price} -> ${result.status}`,
        );
      } catch (err) {
        order.status = 'FAILED';
        order.error = (err as Error).message;
        order = await this.orderRepo.save(order);
        await this.risk.record('exchange_error', 'error', `下单失败: ${order.error}`, symbol, input.decisionId ?? null);
        this.logger.error(`下单失败: ${order.error}`);
      }
    }

    const dto = this.toDTO(order);
    this.events.emit('order', dto);
    return dto;
  }

  async cancelOrder(id: string): Promise<OrderDTO> {
    const order = await this.orderRepo.findOne({ where: { id } });
    if (!order) throw new BusinessException('NOT_FOUND', '订单不存在');

    if (order.mode === 'dry_run') {
      order.status = 'CANCELED';
      const saved = await this.orderRepo.save(order);
      const dto = this.toDTO(saved);
      this.events.emit('order', dto);
      return dto;
    }

    try {
      const adapter = await this.registry.get(order.exchange);
      const result = await adapter.cancelOrder({
        symbol: order.symbol,
        exchangeOrderId: order.exchangeOrderId ?? undefined,
        clientOrderId: order.clientOrderId ?? undefined,
      });
      order.status = result.status || 'CANCELED';
      order.error = null;
    } catch (err) {
      order.error = (err as Error).message;
      await this.risk.record('exchange_error', 'warn', `撤单失败: ${order.error}`, order.symbol);
    }

    const saved = await this.orderRepo.save(order);
    const dto = this.toDTO(saved);
    this.events.emit('order', dto);
    return dto;
  }

  /** 同步未终结订单的最新状态 */
  async syncOpenOrders(): Promise<number> {
    const openOrders = await this.orderRepo.find({
      where: { status: In(['NEW', 'PARTIALLY_FILLED']) },
      take: 100,
    });
    if (openOrders.length === 0) return 0;

    let updated = 0;
    for (const order of openOrders) {
      if (order.mode === 'dry_run') continue;
      try {
        const adapter = await this.registry.get(order.exchange);
        const result = await adapter.getOrder({
          symbol: order.symbol,
          exchangeOrderId: order.exchangeOrderId ?? undefined,
          clientOrderId: order.clientOrderId ?? undefined,
        });
        if (result.status !== order.status || result.filledQuantity !== order.filledQuantity) {
          order.status = result.status;
          order.filledQuantity = result.filledQuantity;
          order.filledPrice = result.filledPrice;
          await this.orderRepo.save(order);
          this.events.emit('order', this.toDTO(order));
          updated += 1;
        }
      } catch (err) {
        this.logger.warn(`同步订单 ${order.id} 失败: ${(err as Error).message}`);
      }
    }
    return updated;
  }

  async list(params: {
    page?: number;
    pageSize?: number;
    status?: OrderStatus;
    symbol?: string;
    source?: OrderSource;
  }): Promise<PageResult<OrderDTO>> {
    const { page, pageSize, skip, take } = normalizePagination(params);
    const qb = this.orderRepo.createQueryBuilder('o');
    if (params.status) qb.andWhere('o.status = :status', { status: params.status });
    if (params.symbol) qb.andWhere('o.symbol = :symbol', { symbol: params.symbol });
    if (params.source) qb.andWhere('o.source = :source', { source: params.source });
    qb.orderBy('o.createdAt', 'DESC').skip(skip).take(take);

    const [rows, total] = await qb.getManyAndCount();
    return toPageResult(rows.map((r) => this.toDTO(r)), total, page, pageSize);
  }

  async recent(limit = 10): Promise<OrderDTO[]> {
    const rows = await this.orderRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => this.toDTO(r));
  }

  async getFills(orderId: string) {
    return this.fillRepo.find({ where: { orderId }, order: { filledAt: 'ASC' } });
  }

  async statsToday(): Promise<{ filled: number; open: number }> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const filled = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.createdAt >= :start', { start })
      .andWhere('o.status = :status', { status: 'FILLED' })
      .getCount();
    const open = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.status IN (:...statuses)', { statuses: ['NEW', 'PARTIALLY_FILLED'] })
      .getCount();
    return { filled, open };
  }
}

function sumAsset(rows: { asset: string; free: number }[], asset: string): number {
  return rows.filter((r) => r.asset === asset).reduce((acc, r) => acc + r.free, 0);
}
