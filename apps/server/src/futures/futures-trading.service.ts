import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  clampLotTpSl,
  clampRiskValue,
  computeFuturesOrderQty,
  DecisionAction,
  floorToStep,
  FuturesOrderIntent,
  isActionableIntent,
  LotExitReason,
  MAX_OPEN_LOTS_PER_DIRECTION,
  normalizeOrder,
  NormalizeResult,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderType,
  resolveFuturesOrderIntentLot,
  resolveLotCloseIntent,
  SymbolFilters,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { OrderEntity, PositionLotEntity, TradeFillEntity } from '../database/entities';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { isFuturesAdapter } from '../exchanges/adapter.interface';
import { EventBusService } from '../common/events';
import { BusinessException } from '../common/business.exception';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesRiskService, FuturesRiskVerdict } from './futures-risk.service';
import { LotService } from '../account/lot.service';

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
  /**
   * 平仓目标 Lot（close_long/close_short 时必传）：
   * 平仓必须全量平掉该 Lot，成交后按 Lot 结算盈亏
   */
  lotId?: string;
  /** 平仓原因（结算 Lot 用） */
  exitReason?: LotExitReason;
  /** 本单止盈止损快照（hybrid AI 逐单给参数；不传用全局兜底） */
  stopLossPct?: number;
  takeProfitPct?: number;
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
 * 估算手续费费率（bps，单边 taker）。
 *
 * 仅在两种场景使用：dry-run 模拟撮合、真实成交但交易所响应未带 fills。
 * 现货链路取 agent_configs.feeRateBps；合约配置没有该参数，固定 taker 基准值。
 * 记 0 会让毛盈亏伪装成净盈亏——本项目 C2 实证费率是净收益的生死线。
 */
const FUTURES_FEE_BPS = 10;

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
    private readonly lots: LotService,
  ) {}

  /**
   * Lot 生命周期挂接（合约侧，dry-run 与真实成交共用）：
   * - close 意图（reduceOnly）：结算指定 Lot（input.lotId），exitReason 由调用方给出
   * - open 意图：新建 Lot（BUY=LONG / SELL=SHORT），TP/SL 快照落库（input ?? 全局兜底）
   */
  private async settleOrOpenLot(
    input: PlaceFuturesOrderInput,
    intent: FuturesOrderIntent,
    order: OrderEntity,
    fill: { price: number; quantity: number; fee: number },
  ): Promise<void> {
    try {
      if (intent.kind === 'close') {
        if (!input.lotId) {
          this.logger.warn(`合约平仓单缺少 lotId（orderId=${order.id}），Lot 无法结算`);
          return;
        }
        await this.lots.settleFromCloseFill({
          lotId: input.lotId,
          closeOrderId: order.id,
          fill,
          exitReason: input.exitReason ?? 'MANUAL',
        });
      } else {
        const tpSl = clampLotTpSl({
          stopLossPct: input.stopLossPct,
          takeProfitPct: input.takeProfitPct,
        });
        await this.lots.createFromOpenFill({
          order,
          fill,
          stopLossPct: tpSl.stopLossPct,
          takeProfitPct: tpSl.takeProfitPct,
        });
      }
    } catch (err) {
      // Lot 记账失败不应让下单流程失败，但必须留痕排查
      this.logger.error(`Lot 挂接失败（orderId=${order.id}）: ${(err as Error).message}`);
    }
  }

  /**
   * 成交对账：补记「已成交但没写 trade_fills / 没建 Lot」的合约订单。
   *
   * **为什么必须有**：demo 环境的 `POST /fapi/v1/order` 响应 `executedQty` 可能为 0
   * （成交是异步完成的），下单时的 `if (result.filledQuantity > 0)` 判断会跳过记账；
   * 后续 `syncOpenOrders` 只更新订单状态与数量，不补记成交明细与 Lot，
   * 造成「订单显示 FILLED 但盈亏永远算不出来」的静默故障。
   *
   * 幂等：trade_fills 按 orderId 去重；Lot 按 openOrderId 去重（createFromOpenFill 已内置）。
   * 因此每轮调度调用都安全，可放心高频执行。
   */
  async syncPendingFills(limit = 100): Promise<{ filled: number; lots: number; skipped: number }> {
    // 已成交（FILLED / PARTIALLY_FILLED）的合约单（有交易所单号才有对账意义）
    const candidates = await this.orderRepo.find({
      where: [
        { market: 'futures', status: 'FILLED' },
        { market: 'futures', status: 'PARTIALLY_FILLED' },
      ],
      order: { createdAt: 'ASC' },
      take: limit * 2,
    });

    // 已写过成交明细的订单（内存差集，避免跨表 join 的 QueryBuilder 兼容性问题）
    const withFillIds = new Set(
      (
        await this.fillRepo
          .createQueryBuilder('f')
          .select('f."orderId"', 'orderId')
          .getRawMany<{ orderId: string }>()
      ).map((r) => r.orderId),
    );
    const rows = candidates
      // exchangeOrderId 为空但 clientOrderId 存在时也要回查：
      // 这是 syncOpenOrders 历史上漏写交易所单号后的存量修复路径。
      .filter((o) => (o.exchangeOrderId || o.clientOrderId) && !withFillIds.has(o.id))
      .slice(0, limit);

    if (rows.length === 0) return { filled: 0, lots: 0, skipped: 0 };

    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    let filled = 0;
    let lots = 0;
    let skipped = 0;

    for (const order of rows) {
      try {
        const detail = await adapter.getOrder({
          symbol: order.symbol,
          exchangeOrderId: order.exchangeOrderId ?? undefined,
          clientOrderId: order.clientOrderId ?? undefined,
        });
        if (!order.exchangeOrderId && detail.exchangeOrderId) {
          order.exchangeOrderId = detail.exchangeOrderId;
        }
        if (!(detail.filledQuantity > 0)) {
          skipped += 1;
          this.logger.debug(`对账跳过（交易所未成交）：orderId=${order.id}`);
          continue;
        }

        const fillPrice = detail.filledPrice > 0 ? detail.filledPrice : order.filledPrice;
        if (!(fillPrice > 0)) {
          skipped += 1;
          this.logger.warn(
            `对账跳过（成交价缺失）：orderId=${order.id} exchangeOrderId=${order.exchangeOrderId}`,
          );
          continue;
        }
        const fee =
          detail.fee ??
          detail.filledQuantity * fillPrice * (FUTURES_FEE_BPS / 10_000);

        await this.fillRepo.save(
          this.fillRepo.create({
            orderId: order.id,
            symbol: order.symbol,
            price: fillPrice,
            quantity: detail.filledQuantity,
            fee,
            feeAsset: detail.feeAsset ?? 'USDT',
            filledAt: new Date(),
          }),
        );
        filled += 1;

        // 补齐订单上的成交信息（下单当时可能为空）
        order.filledQuantity = detail.filledQuantity;
        order.filledPrice = fillPrice;
        await this.orderRepo.save(order);

        // Lot 挂接：reduceOnly=平仓（优先按订单 lotId 精确结算）；否则开仓（建 Lot）
        if (order.reduceOnly) {
          const direction = order.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
          // 优先精确：placeOrder 已把目标 lotId 写入订单（P1 修复，2026-09-02）
          let target: PositionLotEntity | null = null;
          if (order.lotId) {
            target = await this.lots.getOpenLot(order.lotId);
            if (!target) {
              // lotId 指定但 Lot 已完结 → 引擎已精确结算过（该订单不该再进来），
              // 此时**不再 FIFO 兜底**，避免把另一笔还在持仓的 Lot 误结掉
              this.logger.warn(
                `对账：订单 lotId=${order.lotId} 对应 Lot 已不存在或已完结（orderId=${order.id}），` +
                  `认为已被引擎结算，跳过（避免误结其他仓）`,
              );
              skipped += 1;
              continue;
            }
          } else {
            // 历史平仓单（lotId 为空，改造前无此列）：FIFO 猜最老同方向 Lot 兜底
            target = await this.lots.findOldestOpenLot('futures', order.symbol, direction);
          }
          if (!target) {
            this.logger.warn(
              `对账：平仓单未找到可结算的未完结 Lot（orderId=${order.id}），跳过结算`,
            );
            skipped += 1;
          } else {
            await this.lots.settleFromCloseFill({
              lotId: target.id,
              closeOrderId: order.id,
              fill: { price: fillPrice, quantity: detail.filledQuantity, fee },
              exitReason: 'MANUAL',
            });
            lots += 1;
          }
        } else {
          const tpSl = clampLotTpSl({ stopLossPct: null, takeProfitPct: null });
          const created = await this.lots.createFromOpenFill({
            order,
            fill: { price: fillPrice, quantity: detail.filledQuantity, fee },
            stopLossPct: tpSl.stopLossPct,
            takeProfitPct: tpSl.takeProfitPct,
          });
          if (created) lots += 1;
        }

        this.logger.log(
          `对账补记：orderId=${order.id} ${order.side} ${detail.filledQuantity} ${order.symbol} ` +
            `@ ${fillPrice.toFixed(2)}（fee ${fee.toFixed(4)}，reduceOnly=${order.reduceOnly}）`,
        );
      } catch (err) {
        this.logger.error(
          `对账失败（orderId=${order.id}）: ${(err as Error).message}`,
        );
      }
    }

    if (filled > 0 || lots > 0) {
      this.logger.warn(
        `合约成交对账完成：补记成交 ${filled} 笔、Lot ${lots} 个、跳过 ${skipped} 笔`,
      );
    }
    return { filled, lots, skipped };
  }

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
   * 确保账户为双向持仓（hedge mode）——Lot 多空共存的前提。幂等。
   *
   * 只在真实交易模式调用（dry-run 不触交易所）。
   * 交易所侧要求无持仓才能切换，切换前由引擎/用户保证净持仓为零；
   * 若交易所拒绝（仍有持仓/-4067），异常上抛由调用方记为决策失败，绝不静默降级——
   * 单向模式下多空 Lot 语义无法成立。
   */
  async ensureHedgeMode(): Promise<void> {
    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    if (!isFuturesAdapter(adapter) || !adapter.setPositionMode) return;
    await adapter.setPositionMode(true);
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

    // ---- 1. 方向语义（Lot 模型 / hedge mode）----
    // 带 lotId = 平仓单：意图与数量都由目标 Lot 决定（全量 reduceOnly 平掉）
    // 不带 lotId = 开仓单：BUY 恒开多 / SELL 恒开空，与当前净持仓无关（多空可共存）
    let lot: PositionLotEntity | null = null;
    let intent: FuturesOrderIntent;
    if (input.lotId) {
      lot = await this.lots.getOpenLot(input.lotId);
      if (!lot) {
        throw new BusinessException('BAD_REQUEST', `未找到未完结的仓位单（lotId=${input.lotId}）`);
      }
      if (lot.symbol !== symbol) {
        throw new BusinessException('BAD_REQUEST', `仓位单交易对不符（${lot.symbol} ≠ ${symbol}）`);
      }
      intent = resolveLotCloseIntent(lot.direction);
    } else {
      intent = resolveFuturesOrderIntentLot(input.action);
    }

    const currentQty = await this.positions.getNetQuantity(symbol);

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
      // 平仓数量以目标 Lot 为准（全量平掉该单），不是净持仓
      lotQty: lot ? Number(lot.quantity) : undefined,
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
      // 平仓单精确记录目标 Lot，供成交对账精确结算（避免 FIFO 猜错仓）
      lotId: intent.kind === 'close' ? (input.lotId ?? null) : null,
    });
    order = await this.orderRepo.save(order);

    // ---- 6. 发单 / 模拟撮合 ----
    if (mode === 'dry_run') {
      const slippage = DRY_RUN_SLIPPAGE_BPS / 10_000;
      const fillPrice = intent.side === 'BUY' ? price * (1 + slippage) : price * (1 - slippage);
      const dryFee = quantity * fillPrice * (FUTURES_FEE_BPS / 10_000);
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
          // 模拟撮合同样要计费：合约盈亏对费率极度敏感，记 0 会让 dry-run 结果系统性偏乐观
          fee: dryFee,
          feeAsset: 'USDT',
          filledAt: new Date(),
        }),
      );
      // Lot 生命周期挂接（dry-run 与真实同口径，保证回测/模拟可对账）
      await this.settleOrOpenLot(input, intent, order, {
        price: fillPrice,
        quantity,
        fee: dryFee,
      });
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
          this.logger.log(
            `[${mode}][合约] 成交确认：${intent.kind} ${intent.positionSide} ` +
              `${result.filledQuantity} ${symbol} @ ${result.filledPrice || price} ` +
              `fee=${(result.fee ?? '估算').toString()} fills=${result.fee != null ? '交易所回传' : '无→按费率估算'}`,
          );
          const filledFee =
            result.fee ??
            result.filledQuantity * (result.filledPrice || price) * (FUTURES_FEE_BPS / 10_000);
          await this.fillRepo.save(
            this.fillRepo.create({
              orderId: order.id,
              symbol,
              price: result.filledPrice || price,
              quantity: result.filledQuantity,
              // 真实手续费（交易所 fills[].commission 折算为 USDT）；
              // 取不到时按 taker 费率估算，绝不记 0（会把毛盈亏当净盈亏）
              fee: filledFee,
              feeAsset: result.feeAsset ?? 'USDT',
              filledAt: new Date(),
            }),
          );

          // Lot 生命周期挂接：开仓成交建 Lot / 平仓成交结算 Lot
          await this.settleOrOpenLot(input, intent, order, {
            price: result.filledPrice || price,
            quantity: result.filledQuantity,
            fee: filledFee,
          });
        } else {
          // ⚠️ 关键留痕：下单响应未含成交量（demo 环境 executedQty 可能为 0）。
          // 成交明细与 Lot 由调度器的 syncPendingFills 对账补记；若不补记，盈亏将无法计算。
          this.logger.warn(
            `[${mode}][合约] 下单响应未含成交量（status=${result.status}，` +
              `exchangeOrderId=${result.exchangeOrderId}），成交明细与 Lot 将由对账任务补记 ` +
              `orderId=${order.id}`,
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
    /** 平仓目标 Lot 的数量：close 意图时优先于净持仓（Lot 模型按单全平） */
    lotQty?: number;
    explicitQty?: number;
    availableMargin: number;
    positionPct: number;
    leverage: number;
    price: number;
    filters: SymbolFilters;
  }): Promise<{ quantity: number; notional: number; margin: number; note?: string }> {
    const { intent, filters, price } = input;

    // 平仓：优先按目标 Lot 全平；无 Lot 时按净持仓兜底（兼容历史调用），取整避免浮点残留
    if (intent.kind === 'close') {
      const raw = input.lotQty ?? Math.abs(input.currentQty);
      const qty = floorToStep(raw, filters.stepSize);
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
