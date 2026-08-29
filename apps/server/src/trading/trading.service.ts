import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  clampRiskValue,
  DEFAULT_SYMBOL,
  ExchangeCode,
  normalizeOrder,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
  NormalizeResult,
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
}

/**
 * 下单结论。
 *
 * `risk` 始终是 TradingService 内的权威判定结果。
 * 调用方（如 Agent）可自行做一次咨询性预检用于快速失败，
 * 但不得以此替代本处结论——否则上游与下游两次读价之间的漂移会让风控形同虚设。
 */
export interface PlaceOrderResult {
  order: OrderDTO;
  risk: { passed: boolean; rejectedBy?: string; note?: string };
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

  /**
   * 下单唯一出口：确定价格 -> 按交易所精度取整 -> 权威风控 -> 发单。
   *
   * 风控必须基于**最终取整后的数量与实际成交价**执行，
   * 否则调用方用未取整数量和旧快照价算出的金额，与这里实际下单的金额不一致。
   */
  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const agentConfig = await this.agentConfig.getOrCreate();
    const config = this.agentConfig.toShape(agentConfig);
    const symbol = input.symbol ?? config.symbol ?? DEFAULT_SYMBOL;
    const mode: RunMode = config.mode;
    const exchange: ExchangeCode = input.exchange ?? config.enabledExchanges?.[0] ?? 'binance';

    this.market.ensureSymbol(symbol);
    const ticker = this.market.getTicker(symbol);
    const marketPrice = ticker.price || 0;
    if (!(marketPrice > 0)) {
      throw new BusinessException('EXCHANGE_ERROR', '无法获取当前价格，下单已取消');
    }

    const requestedQty = Number(input.quantity);
    if (!(requestedQty > 0)) {
      throw new BusinessException('BAD_REQUEST', '下单数量必须大于 0');
    }

    // ---- 按交易所精度取整，得到真正会被提交的订单参数 ----
    const adapter = await this.registry.get(exchange);
    const filters = await adapter.getSymbolFilters(symbol);
    const normalized = normalizeOrder({
      quantity: requestedQty,
      price: input.type === 'LIMIT' && input.price ? input.price : marketPrice,
      filters,
      type: input.type,
    });
    // 注意：本项目 strictNullChecks=false，布尔字面量会被拓宽成 boolean，
    // 判别联合无法自动收窄，这里显式断言出成功分支
    if (!normalized.ok) {
      const failure = normalized as Extract<NormalizeResult, { ok: false }>;
      await this.risk.record(
        'reject',
        'warn',
        `${input.side} ${symbol} 订单参数不合法：${failure.note}`,
        symbol,
        input.decisionId ?? null,
      );
      throw new BusinessException('BAD_REQUEST', failure.note);
    }

    const ok = normalized as Extract<NormalizeResult, { ok: true }>;
    const quantity = ok.quantity;
    const price = ok.price ?? marketPrice;
    // 风控金额以取整后的最终结果为准，消除上下游两次读价的漂移
    const quoteAmount = ok.quoteAmount;

    // ---- 权威风控（自动单与手动单统一，无条件执行） ----
    const balances = await this.accounts.getBalances(mode, config.enabledExchanges);
    const quoteFree = sumAsset(balances.rows, 'USDT');
    const baseFree = sumAsset(balances.rows, 'BTC');
    const riskVerdict = await this.risk.check({
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
      // 模拟撮合引入滑点：买入向上滑、卖出向下滑，避免回测结果系统性偏乐观
      const slippage = clampRiskValue('slippageBps', config.slippageBps) / 10_000;
      const fillPrice =
        input.side === 'BUY' ? price * (1 + slippage) : price * (1 - slippage);
      const filledQuote = quantity * fillPrice;
      const feeRate = clampRiskValue('feeRateBps', config.feeRateBps) / 10_000;

      order.status = 'FILLED';
      order.filledQuantity = quantity;
      order.filledPrice = fillPrice;
      order.exchangeOrderId = `DRY_${order.id.slice(0, 8)}`;
      order = await this.orderRepo.save(order);
      await this.fillRepo.save(
        this.fillRepo.create({
          orderId: order.id,
          symbol,
          price: fillPrice,
          quantity,
          fee: filledQuote * feeRate,
          feeAsset: 'USDT',
          filledAt: new Date(),
        }),
      );
      this.logger.log(
        `[dry-run] ${input.side} ${quantity} ${symbol} @ ${fillPrice.toFixed(2)}` +
          ` (滑点 ${(slippage * 10_000).toFixed(1)}bps, 费率 ${(feeRate * 10_000).toFixed(1)}bps)`,
      );
    } else {
      try {
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
    return { order: dto, risk: riskVerdict };
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
