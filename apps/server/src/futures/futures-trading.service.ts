import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  computeFuturesOrderQty,
  DecisionAction,
  floorToStep,
  FuturesOrderIntent,
  LotExitReason,
  normalizeOrder,
  NormalizeResult,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderType,
  PositionSide,
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
import { LotService } from '../account/lot.service';

export interface PlaceFuturesOrderInput {
  symbol?: string;
  /** 策略输出的动作；由本服务翻译成合约方向语义 */
  action: DecisionAction;
  type?: OrderType;
  /** 限价单价格；市价单忽略 */
  price?: number;
  source: OrderSource;
  /** 覆盖配置杠杆（手动单用；平台不做上限钳制，多少由策略/用户决定） */
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
}

/**
 * 下单前置校验结论。
 *
 * 平台**不做业务风控**（层数、敞口、熔断、日亏损全部由策略自负），
 * 这里只表达「本次下单是否被必然失败性的参数问题拦下」。
 */
export interface PlacementVerdict {
  passed: boolean;
  rejectedBy?: string;
  note?: string;
}

export interface PlaceFuturesOrderResult {
  /** 未下单（观望）时为 null */
  order: OrderDTO | null;
  intent: FuturesOrderIntent;
  risk: PlacementVerdict;
  /** 实际生效杠杆 */
  leverage: number;
  /** 下单前推导的数量与保证金，便于审计与前端展示 */
  sizing: { quantity: number; notional: number; margin: number };
}

const FUTURES_EXCHANGE = 'binance-futures' as const;

/**
 * 是否为条件单（Algo Order）。
 *
 * 币安自 2025-12 起把止盈止损/条件单迁到独立端点，
 * 创建、查询、撤销都必须走 `/fapi/v1/algoOrder`，
 * 用普通订单端点会被拒（-4120）。因此回查与撤销时要带上这个标记。
 */
function isConditionalOrder(type: string): boolean {
  return type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET';
}

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
        await this.lots.createFromOpenFill({ order, fill });
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
    // 含 NEW：挂单（STOP_MARKET）被交易所触发后本地仍是 NEW，
    // 不回查就永远发现不了已成交，网格层也就永远不建 Lot。
    const candidates = await this.orderRepo.find({
      where: [
        { market: 'futures', status: 'NEW' },
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
      // dry_run 的单只存在于本地，交易所没有它，回查必然失败 →
      // 交给 processDryRunGridOrders 按行情模拟触发。
      .filter((o) => o.mode !== 'dry_run')
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
          // 条件单必须查 Algo 端点，否则查不到单（-2013）
          conditional: isConditionalOrder(order.type),
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

        // 补齐订单上的成交信息（下单当时可能为空），并把状态推进到终态：
        // 网格挂单在成交前一直是 NEW，不更新状态会被反复回查。
        order.filledQuantity = detail.filledQuantity;
        order.filledPrice = fillPrice;
        order.status =
          detail.status === 'PARTIALLY_FILLED' ||
          detail.filledQuantity < Number(order.quantity)
            ? 'PARTIALLY_FILLED'
            : 'FILLED';
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
          const created = await this.lots.createFromOpenFill({
            order,
            fill: { price: fillPrice, quantity: detail.filledQuantity, fee },
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
   * 合约下单唯一出口。
   *
   * 流程：方向语义（Lot / hedge）→ 数量推导 → 精度取整 → 交易所参数前置校验
   * → 设置杠杆/保证金 → 发单 → 落库。
   *
   * 平台**不做风控**：层数、敞口、杠杆上限、熔断、日亏损等一律不检查，
   * 由策略自行负责；这里只拦「必然失败」的参数问题（最小名义、数量精度）。
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

    // 平台不做杠杆风控：策略/手动指定即生效（未指定用配置值）。
    // 只做正整数规范化，避免 NaN/0 这类必然失败的参数。
    const leverage = Math.max(1, Math.floor(input.leverage ?? cfg.leverage));

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
      // normalizeOrder 只区分「市价/限价」两种取整口径；
      // 条件单的价格同样要落在 tickSize 网格上，故按限价口径取整。
      type: type === 'LIMIT' ? 'LIMIT' : 'MARKET',
    });
    if (!normalized.ok) {
      const failure = normalized as Extract<NormalizeResult, { ok: false }>;
      throw new BusinessException('BAD_REQUEST', failure.note);
    }
    const ok = normalized as Extract<NormalizeResult, { ok: true }>;
    const quantity = ok.quantity;
    const price = ok.price ?? marketPrice;
    const notional = ok.quoteAmount;
    const margin = notional / leverage;

    // ---- 4. 前置校验（不是风控）----
    // 平台只保证「指令能正确送达交易所」：拦下必然失败的参数问题。
    // 层数、马丁倍率、敞口、熔断、日亏损等业务风控**一律不做**——那是策略自己的责任。
    if (filters.minNotional > 0 && notional < filters.minNotional) {
      throw new BusinessException(
        'BAD_REQUEST',
        `名义价值 ${notional.toFixed(2)} 低于交易所最小要求 ${filters.minNotional}`,
      );
    }
    const placement: PlacementVerdict = { passed: true };

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
        this.logger.error(`合约下单失败: ${order.error}`);
      }
    }

    const dto = this.toDTO(order);
    this.events.emit('order', dto);

    return {
      order: dto,
      intent,
      risk: placement,
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
  // 注：`loadPositionRisk` 已移除——它只为「强平距离风控」提供输入，
  // 而平台已不做风控（那是策略自己的事）。

  /** 合约订单列表（按 market 隔离，不混入现货） */
  async list(params: { limit?: number } = {}): Promise<OrderDTO[]> {
    const rows = await this.orderRepo.find({
      where: { market: 'futures' },
      order: { createdAt: 'DESC' },
      take: Math.min(100, Math.max(1, params.limit ?? 20)),
    });
    return rows.map((r) => this.toDTO(r));
  }

  /**
   * 挂出**条件触发单**（网格的待成交层）。
   *
   * 与 `placeOrder` 的区别：
   * - 不立即成交、不建 Lot——订单停在 `NEW`，交易所触发后由 `syncPendingFills` 补记
   * - 不做数量推导（数量由策略决定），只做精度取整与最小名义校验
   * - `dry_run` 不触交易所，由 `processDryRunGridOrders` 按行情模拟触发
   *
   * 触发语义即 MT5 挂单：BUY 上破 stopPrice 买入 / SELL 下破 stopPrice 卖出。
   */
  async placeStopOrder(input: {
    symbol?: string;
    side: OrderSide;
    positionSide: PositionSide;
    stopPrice: number;
    quantity: number;
    source: OrderSource;
    /** 用途说明（仅日志留痕，如 grid-long-L2） */
    note?: string;
  }): Promise<OrderDTO> {
    const cfg = await this.futuresConfig.get();
    const symbol = input.symbol ?? cfg.symbol;
    const mode = cfg.mode;

    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    if (!isFuturesAdapter(adapter)) {
      throw new BusinessException('EXCHANGE_ERROR', '合约适配器不支持交易');
    }
    const filters: SymbolFilters = await adapter.getSymbolFilters(symbol);

    // 用 LIMIT 口径做取整：触发价同样必须落在 tickSize 网格上
    const normalized = normalizeOrder({
      quantity: input.quantity,
      price: input.stopPrice,
      filters,
      type: 'LIMIT',
    });
    if (!normalized.ok) {
      const failure = normalized as Extract<NormalizeResult, { ok: false }>;
      throw new BusinessException('BAD_REQUEST', failure.note);
    }
    const ok = normalized as Extract<NormalizeResult, { ok: true }>;
    const quantity = ok.quantity;
    const stopPrice = ok.price ?? input.stopPrice;
    const notional = quantity * stopPrice;

    if (filters.minNotional > 0 && notional < filters.minNotional) {
      throw new BusinessException(
        'BAD_REQUEST',
        `挂单名义价值 ${notional.toFixed(2)} 低于交易所最小要求 ${filters.minNotional}`,
      );
    }

    const clientOrderId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let order = this.orderRepo.create({
      exchange: FUTURES_EXCHANGE,
      market: 'futures',
      environment: mode === 'live' ? 'live' : 'testnet',
      mode,
      symbol,
      side: input.side,
      type: 'STOP_MARKET',
      price: 0,
      stopPrice,
      quantity,
      quoteAmount: notional,
      status: 'NEW',
      clientOrderId,
      source: input.source,
      leverage: Math.max(1, Math.floor(cfg.leverage)),
      // hedge 模式下开仓单必须带 positionSide，否则交易所无法判断挂在哪个方向
      positionSide: input.positionSide,
      reduceOnly: false,
    });
    order = await this.orderRepo.save(order);

    if (mode === 'dry_run') {
      this.logger.log(
        `[dry_run] 网格挂单 ${input.side}/${input.positionSide} ${quantity} ${symbol} ` +
          `触发价 ${stopPrice}（${input.note ?? ''}）`,
      );
      return this.toDTO(order);
    }

    try {
      const result = await adapter.placeOrder({
        symbol,
        side: input.side,
        type: 'STOP_MARKET',
        quantity,
        stopPrice,
        positionSide: input.positionSide,
        clientOrderId,
      });
      order.exchangeOrderId = result.exchangeOrderId;
      // 触发价可能已被行情穿越并立即成交（交易所直接返回 FILLED）
      order.status = result.status === 'FILLED' ? 'FILLED' : 'NEW';
      order = await this.orderRepo.save(order);
      this.logger.log(
        `[${mode}] 网格挂单 ${input.side}/${input.positionSide} ${quantity} ${symbol} ` +
          `触发价 ${stopPrice} -> ${order.status}（${input.note ?? ''}）`,
      );
    } catch (err) {
      order.status = 'FAILED';
      order.error = (err as Error).message;
      order = await this.orderRepo.save(order);
      this.logger.error(`网格挂单失败: ${order.error}`);
      throw new BusinessException('EXCHANGE_ERROR', `挂单失败：${order.error}`);
    }
    return this.toDTO(order);
  }

  /**
   * 撤销未成交订单（网格重排 / 篮子出场前清理挂单）。
   * dry_run 的单只在本地，直接标记撤销。
   */
  async cancelOrder(orderId: string): Promise<OrderDTO> {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) {
      throw new BusinessException('NOT_FOUND', `订单不存在：${orderId}`);
    }
    if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') {
      throw new BusinessException('BAD_REQUEST', `订单当前状态 ${order.status}，不可撤销`);
    }

    if (order.mode === 'dry_run' || !order.exchangeOrderId) {
      order.status = 'CANCELED';
      return this.toDTO(await this.orderRepo.save(order));
    }

    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    try {
      await adapter.cancelOrder({
        symbol: order.symbol,
        exchangeOrderId: order.exchangeOrderId ?? undefined,
        clientOrderId: order.clientOrderId ?? undefined,
        // 条件单要走 Algo 端点撤销
        conditional: isConditionalOrder(order.type),
      });
    } catch (err) {
      const message = (err as Error).message;
      order.error = message;
      await this.orderRepo.save(order);
      this.logger.warn(`撤单失败（orderId=${orderId}）：${message}`);
      throw new BusinessException('EXCHANGE_ERROR', `撤单失败：${message}`);
    }
    order.status = 'CANCELED';
    const saved = await this.orderRepo.save(order);
    this.logger.log(`已撤单：${order.side} ${order.quantity} ${order.symbol}（orderId=${orderId}）`);
    return this.toDTO(saved);
  }

  /** 未成交订单（策略的网格待成交层）：运行器构造 ctx.openOrders 用它 */
  async listOpenOrders(symbol?: string): Promise<OrderEntity[]> {
    return this.orderRepo.find({
      where: symbol
        ? { market: 'futures', symbol, status: 'NEW' }
        : { market: 'futures', status: 'NEW' },
      order: { createdAt: 'ASC' },
      take: 100,
    });
  }

  /**
   * `dry_run` 挂单的模拟触发。
   *
   * dry_run 不触交易所，挂单永远不会被撮合；这里按当前价判断是否穿越触发价，
   * 穿越即按「触发价 ± 滑点」模拟成交并建 Lot——与真实成交共用同一套记账与
   * Lot 结算路径，保证 dry-run 的结果与实盘口径一致（只差真实滑点）。
   */
  async processDryRunGridOrders(symbol: string): Promise<{ triggered: number }> {
    const cfg = await this.futuresConfig.get();
    if (cfg.mode !== 'dry_run') return { triggered: 0 };

    const orders = await this.orderRepo.find({
      where: { market: 'futures', symbol, status: 'NEW', mode: 'dry_run' },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    if (orders.length === 0) return { triggered: 0 };

    const adapter = await this.registry.get(FUTURES_EXCHANGE);
    const ticker = await adapter.getTicker(symbol);
    const price = ticker.price || 0;
    if (!(price > 0)) return { triggered: 0 };

    let triggered = 0;
    for (const order of orders) {
      const stop = Number(order.stopPrice ?? 0);
      if (!(stop > 0)) continue;
      // STOP_MARKET：BUY 上破触发 / SELL 下破触发
      const hit = order.side === 'BUY' ? price >= stop : price <= stop;
      if (!hit) continue;

      const slippage = DRY_RUN_SLIPPAGE_BPS / 10_000;
      const fillPrice = order.side === 'BUY' ? stop * (1 + slippage) : stop * (1 - slippage);
      const fee = order.quantity * fillPrice * (FUTURES_FEE_BPS / 10_000);

      await this.fillRepo.save(
        this.fillRepo.create({
          orderId: order.id,
          symbol,
          price: fillPrice,
          quantity: order.quantity,
          fee,
          feeAsset: 'USDT',
          filledAt: new Date(),
        }),
      );
      order.status = 'FILLED';
      order.filledQuantity = Number(order.quantity);
      order.filledPrice = fillPrice;
      await this.orderRepo.save(order);

      await this.lots.createFromOpenFill({
        order,
        fill: { price: fillPrice, quantity: Number(order.quantity), fee },
      });

      triggered += 1;
      this.logger.log(
        `[dry_run] 网格挂单触发成交：${order.side}/${order.positionSide} ` +
          `${order.quantity} ${symbol} @ ${fillPrice.toFixed(2)}`,
      );
    }
    return { triggered };
  }
}
