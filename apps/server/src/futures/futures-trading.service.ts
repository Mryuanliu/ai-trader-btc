import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  clampRiskValue,
  computeFuturesOrderQty,
  DecisionAction,
  floorToStep,
  FuturesOrderIntent,
  isActionableIntent,
  normalizeOrder,
  NormalizeResult,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderType,
  resolveFuturesOrderIntent,
  SymbolFilters,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { OrderEntity, TradeFillEntity } from '../database/entities';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { isFuturesAdapter } from '../exchanges/adapter.interface';
import { EventBusService } from '../common/events';
import { BusinessException } from '../common/business.exception';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesRiskService, FuturesRiskVerdict } from './futures-risk.service';

export interface PlaceFuturesOrderInput {
  symbol?: string;
  /** 策略输出的动作；由本服务翻译成合约方向语义 */
  action: DecisionAction;
  type?: OrderType;
  /** 限价单价格；市价单忽略 */
  price?: number;
  source: OrderSource;
  decisionId?: string | null;
  /** 实盘二次确认 Token */
  confirmToken?: string;
  /** 覆盖配置杠杆（手动单用，仍受 maxLeverage 钳制） */
  leverage?: number;
  /** 直接指定数量（手动单用）；不传则按保证金预算推导 */
  quantity?: number;
}

export interface PlaceFuturesOrderResult {
  /** 未下单（观望）时为 null */
  order: OrderDTO | null;
  intent: FuturesOrderIntent;
  risk: FuturesRiskVerdict;
  /** 实际生效杠杆 */
  leverage: number;
  /** 下单前推导的数量与保证金，便于审计与前端展示 */
  sizing: { quantity: number; notional: number; margin: number };
}

const FUTURES_EXCHANGE = 'binance-futures' as const;

/** dry-run 模拟撮合滑点（bps）。合约配置未单列该参数，先固定，与现货默认一致 */
const DRY_RUN_SLIPPAGE_BPS = 5;

/**
 * 合约执行器：把策略动作翻译成合约订单并执行。
 *
 * 与现货 TradingService 平行，不复用其内部逻辑——
 * 方向语义、仓位计算、保证金与杠杆、风控口径全都不同，
 * 强行复用会让两边都充满分支判断（对应方案里的 L4 横向隔离）。
 */
@Injectable()
export class FuturesTradingService {
  private readonly logger = new Logger(FuturesTradingService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(TradeFillEntity)
    private readonly fillRepo: Repository<TradeFillEntity>,
    private readonly registry: ExchangeRegistry,
    private readonly futuresConfig: FuturesConfigService,
    private readonly positions: FuturesPositionService,
    private readonly risk: FuturesRiskService,
    private readonly events: EventBusService,
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

  /** 合约账户可用保证金（USDT） */
  async getAvailableMargin(): Promise<number> {
    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    const balances = await adapter.getBalances();
    const usdt = balances.find((b) => b.asset === 'USDT');
    return usdt?.free ?? 0;
  }

  /**
   * 合约下单唯一出口：
   * 动作翻译 → 数量推导 → 精度取整 → 权威风控 → 设置杠杆/保证金 → 发单。
   */
  async placeOrder(input: PlaceFuturesOrderInput): Promise<PlaceFuturesOrderResult> {
    const cfg = await this.futuresConfig.get();
    const symbol = input.symbol ?? cfg.symbol;
    const type = input.type ?? 'MARKET';
    const mode = cfg.mode;

    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    if (!isFuturesAdapter(adapter)) {
      throw new BusinessException('EXCHANGE_ERROR', '合约适配器不支持交易');
    }

    // 用合约自身行情定价，而非现货 ticker：两者存在基差，
    // 用现货价算合约保证金会系统性偏差
    const ticker = await adapter.getTicker(symbol);
    const marketPrice = ticker.price || 0;
    if (!(marketPrice > 0)) {
      throw new BusinessException('EXCHANGE_ERROR', '无法获取合约当前价格，下单已取消');
    }

    // ---- 1. 方向语义：策略动作 + 当前持仓 -> 开/加/平 ----
    const currentQty = await this.positions.getNetQuantity(symbol);
    const intent = resolveFuturesOrderIntent(input.action, currentQty);

    const leverage = this.risk.effectiveLeverage(
      input.leverage !== undefined ? { ...cfg, leverage: input.leverage } : cfg,
    );

    // 判别式收窄：hold 分支可直接读 reason，之后 intent 即开/加/平三态
    if (intent.kind === 'hold') {
      return {
        order: null,
        intent,
        risk: { passed: false, rejectedBy: 'HOLD', note: intent.reason },
        leverage,
        sizing: { quantity: 0, notional: 0, margin: 0 },
      };
    }

    // ---- 2. 数量推导 ----
    const filters: SymbolFilters = await adapter.getSymbolFilters(symbol);
    const sizing = await this.resolveQuantity({
      intent,
      currentQty,
      explicitQty: input.quantity,
      availableMargin: await this.getAvailableMargin(),
      positionPct: cfg.positionPct,
      leverage,
      price: input.type === 'LIMIT' && input.price ? input.price : marketPrice,
      filters,
    });
    if (!(sizing.quantity > 0)) {
      throw new BusinessException('BAD_REQUEST', sizing.note ?? '无法推导合法下单数量');
    }

    // ---- 3. 交易所精度取整 ----
    const normalized = normalizeOrder({
      quantity: sizing.quantity,
      price: type === 'LIMIT' && input.price ? input.price : marketPrice,
      filters,
      type,
    });
    if (!normalized.ok) {
      const failure = normalized as Extract<NormalizeResult, { ok: false }>;
      await this.risk.record(
        'reject',
        'warn',
        `${intent.kind} ${symbol} 订单参数不合法：${failure.note}`,
        symbol,
        input.decisionId ?? null,
      );
      throw new BusinessException('BAD_REQUEST', failure.note);
    }
    const ok = normalized as Extract<NormalizeResult, { ok: true }>;
    const quantity = ok.quantity;
    const price = ok.price ?? marketPrice;
    const notional = ok.quoteAmount;
    const margin = notional / leverage;

    // ---- 4. 权威风控 ----
    const currentPosition = await this.loadPositionRisk(symbol);
    const riskVerdict = await this.risk.check({
      config: cfg,
      symbol,
      intent,
      quantity,
      price,
      notional,
      margin,
      availableMargin: await this.getAvailableMargin(),
      currentPosition,
      minNotional: filters.minNotional,
      source: input.source,
      confirmToken: input.confirmToken,
      liveConfirmToken: this.config.get<string>('LIVE_TRADING_CONFIRM_TOKEN', ''),
    });
    if (!riskVerdict.passed) {
      await this.risk.record(
        'reject',
        'warn',
        `${intent.kind} ${symbol} 被合约风控拦截：${riskVerdict.note}`,
        symbol,
        input.decisionId ?? null,
      );
      throw new BusinessException('RISK_REJECTED', riskVerdict.note ?? '合约风控拦截');
    }

    // ---- 5. 落库 ----
    const clientOrderId = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const environment = mode === 'live' ? 'live' : 'testnet';
    let order = this.orderRepo.create({
      exchange: FUTURES_EXCHANGE,
      market: 'futures',
      environment,
      mode,
      symbol,
      side: intent.side as OrderSide,
      type,
      price,
      quantity,
      quoteAmount: notional,
      status: 'NEW',
      clientOrderId,
      source: input.source,
      decisionId: input.decisionId ?? null,
      leverage,
      positionSide: intent.positionSide,
      reduceOnly: intent.kind === 'close',
    });
    order = await this.orderRepo.save(order);

    // ---- 6. 发单 / 模拟撮合 ----
    if (mode === 'dry_run') {
      const slippage = DRY_RUN_SLIPPAGE_BPS / 10_000;
      const fillPrice = intent.side === 'BUY' ? price * (1 + slippage) : price * (1 - slippage);
      order.status = 'FILLED';
      order.filledQuantity = quantity;
      order.filledPrice = fillPrice;
      order.exchangeOrderId = `DRYF_${order.id.slice(0, 8)}`;
      order = await this.orderRepo.save(order);
      await this.fillRepo.save(
        this.fillRepo.create({
          orderId: order.id,
          symbol,
          price: fillPrice,
          quantity,
          fee: 0,
          feeAsset: 'USDT',
          filledAt: new Date(),
        }),
      );
      this.logger.log(
        `[dry-run][合约] ${intent.kind} ${intent.positionSide} ${quantity} ${symbol} @ ${fillPrice.toFixed(2)}`,
      );
    } else {
      try {
        // 开仓/加仓前设置保证金模式与杠杆；平仓单无需设置（不增加风险敞口）
        if (intent.kind !== 'close') {
          await adapter.setMarginType(symbol, cfg.marginType);
          await adapter.setLeverage(symbol, leverage);
        }

        const result = await adapter.placeOrder({
          symbol,
          side: intent.side,
          type,
          quantity,
          price: type === 'LIMIT' ? price : undefined,
          clientOrderId,
          positionSide: intent.positionSide,
          reduceOnly: intent.reduceOnly,
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
          `[${mode}][合约] ${intent.kind} ${intent.positionSide} ${quantity} ${symbol} ` +
            `@ ${price} 杠杆 ${leverage}x -> ${result.status}`,
        );
      } catch (err) {
        order.status = 'FAILED';
        order.error = (err as Error).message;
        order = await this.orderRepo.save(order);
        await this.risk.record(
          'exchange_error',
          'error',
          `合约下单失败: ${order.error}`,
          symbol,
          input.decisionId ?? null,
        );
        this.logger.error(`合约下单失败: ${order.error}`);
      }
    }

    const dto = this.toDTO(order);
    this.events.emit('order', dto);

    return {
      order: dto,
      intent,
      risk: riskVerdict,
      leverage,
      sizing: { quantity, notional, margin },
    };
  }

  /** 数量推导：平仓用当前持仓量，开仓/加仓用保证金预算 */
  private async resolveQuantity(input: {
    intent: Exclude<FuturesOrderIntent, { kind: 'hold' }>;
    currentQty: number;
    explicitQty?: number;
    availableMargin: number;
    positionPct: number;
    leverage: number;
    price: number;
    filters: SymbolFilters;
  }): Promise<{ quantity: number; notional: number; margin: number; note?: string }> {
    const { intent, filters, price } = input;

    // 平仓：按当前持仓量全平，取整避免浮点残留
    if (intent.kind === 'close') {
      const qty = floorToStep(Math.abs(input.currentQty), filters.stepSize);
      if (!(qty > 0)) {
        return { quantity: 0, notional: 0, margin: 0, note: '无持仓可平' };
      }
      return { quantity: qty, notional: qty * price, margin: (qty * price) / input.leverage };
    }

    // 手动指定数量时直接用
    if (input.explicitQty !== undefined && input.explicitQty > 0) {
      const qty = floorToStep(input.explicitQty, filters.stepSize);
      return {
        quantity: qty,
        notional: qty * price,
        margin: (qty * price) / input.leverage,
      };
    }

    return computeFuturesOrderQty({
      availableMargin: input.availableMargin,
      positionPct: input.positionPct,
      leverage: input.leverage,
      price,
      stepSize: filters.stepSize,
    });
  }

  /** 取当前持仓的强平距离，供风控判断是否允许加仓 */
  private async loadPositionRisk(symbol: string) {
    try {
      const rows = await this.positions.listPositions(symbol);
      const row = rows.find((r) => r.symbol === symbol);
      if (!row) return null;
      return {
        quantity: row.quantity,
        liquidationDistancePct: row.liquidationDistancePct,
      };
    } catch (err) {
      this.logger.warn(`读取持仓风险失败，跳过强平距离校验: ${(err as Error).message}`);
      return null;
    }
  }

  /** 合约订单列表（按 market 隔离，不混入现货） */
  async list(params: { limit?: number } = {}): Promise<OrderDTO[]> {
    const rows = await this.orderRepo.find({
      where: { market: 'futures' },
      order: { createdAt: 'DESC' },
      take: Math.min(100, Math.max(1, params.limit ?? 20)),
    });
    return rows.map((r) => this.toDTO(r));
  }
}
