import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DailyRealizedPnl, LotDirection, LotExitReason, MarketType, RunMode, settleLotPnl } from '@ai-trader/shared';
import { OrderEntity } from '../database/entities/order.entity';
import { PositionLotEntity } from '../database/entities/position-lot.entity';
import { BasketService } from './basket.service';
import { EventBusService } from '../common/events';

@Injectable()
export class LotService {
  private readonly logger = new Logger(LotService.name);

  constructor(
    @InjectRepository(PositionLotEntity)
    private readonly lotRepo: Repository<PositionLotEntity>,
    private readonly baskets: BasketService,
    private readonly events: EventBusService,
  ) {}

  /**
   * 开仓成交回调：为开仓订单建立 Lot（幂等，openOrderId 唯一）。
   *
   * 不设逐层止盈止损：出场由策略负责（马丁网格用篮子追踪止盈），
   * 平台既不扫描也不落这些参数。
   */
  async createFromOpenFill(params: {
    order: OrderEntity;
    fill: { price: number; quantity: number; fee: number };
  }): Promise<PositionLotEntity | null> {
    const { order, fill } = params;
    if (!(fill.quantity > 0) || !(fill.price > 0)) return null;

    const existing = await this.lotRepo.findOne({ where: { openOrderId: order.id } });
    if (existing) return existing;

    // 方向：现货不能做空恒 LONG；合约 hedge 模式 BUY=开多 / SELL=开空
    const direction: LotDirection =
      order.market === 'futures' ? (order.side === 'BUY' ? 'LONG' : 'SHORT') : 'LONG';

    const lot = this.lotRepo.create({
      market: order.market,
      symbol: order.symbol,
      // 实例归属从订单继承：这是「每个策略实例只管自己的仓」的数据基础
      strategyInstanceId: order.strategyInstanceId ?? null,
      direction,
      openOrderId: order.id,
      closeOrderId: null,
      quantity: fill.quantity,
      closedQuantity: 0,
      entryPrice: fill.price,
      entryFeeUsdt: fill.fee ?? 0,
      status: 'OPEN',
      openedAt: new Date(),
    });
    const saved = await this.lotRepo.save(lot);
    // 挂到当前篮子上：一次「建仓 → 全部了结」的周期就是一个篮子，
    // 有了它才能算出「这一轮整体赚了多少」——单看每一层毫无意义（加层时中间层都在浮亏）
    // 篮子按实例隔离：多实例下不同策略各开各的篮子，互不干扰
    await this.baskets.attachLot(saved, order.source, order.strategyInstanceId);
    this.logger.log(
      `Lot 建仓 ${order.market} ${direction} ${fill.quantity} ${order.symbol} @ ${fill.price}`,
    );
    // 开仓成交事件：供飞书等外推通知订阅（mode 决定 dry_run 是否过滤）
    this.events.emit('lotOpened', {
      symbol: saved.symbol,
      market: saved.market,
      direction: saved.direction,
      quantity: Number(saved.quantity),
      entryPrice: Number(saved.entryPrice),
      fee: Number(saved.entryFeeUsdt),
      strategyInstanceId: saved.strategyInstanceId ?? null,
      source: order.source,
      mode: order.mode,
      ts: Date.now(),
    });
    return saved;
  }

  /**
   * 平仓成交回调：按 lotId 结算 Lot。
   *
   * 直接用 lotId 而不是按 closeOrderId 反查：平仓下单失败时无需清理预关联，
   * 只有真正成交（回调发生）才落 closeOrderId 并结算。
   * 盈亏用 shared 的 settleLotPnl（毛盈亏 − 双边手续费），与回测同口径。
   */
  async settleFromCloseFill(params: {
    lotId: string;
    closeOrderId: string;
    fill: { price: number; quantity: number; fee: number };
    exitReason: LotExitReason;
    /** 结算所属运行模式（dry_run/testnet/live）：供通知层过滤 */
    mode: RunMode;
  }): Promise<PositionLotEntity | null> {
    const { lotId, closeOrderId, fill, exitReason, mode } = params;
    const lot = await this.getOpenLot(lotId);
    if (!lot) {
      this.logger.warn(`平仓结算未找到未完结 Lot（lotId=${lotId}），跳过`);
      return null;
    }

    const closedQty = Math.min(fill.quantity, lot.quantity);
    const { realizedPnl, returnPct } = settleLotPnl({
      direction: lot.direction,
      quantity: closedQty,
      entryPrice: Number(lot.entryPrice),
      exitPrice: fill.price,
      entryFee: Number(lot.entryFeeUsdt),
      exitFee: fill.fee ?? 0,
    });

    lot.exitPrice = fill.price;
    lot.exitFeeUsdt = fill.fee ?? 0;
    lot.closedQuantity = closedQty;
    lot.realizedPnl = realizedPnl;
    lot.returnPct = returnPct;
    lot.exitReason = exitReason;
    lot.status = 'CLOSED';
    lot.closedAt = new Date();
    const saved = await this.lotRepo.save(lot);
    // 重算篮子统计；若这是最后一层，篮子会被关闭并落定整体盈亏
    await this.baskets.onLotSettled(lot.basketId, mode);
    this.logger.log(
      `Lot 结算 ${lot.market} ${lot.direction} ${lot.symbol} ${exitReason}: pnl=${realizedPnl} (${(returnPct * 100).toFixed(2)}%)`,
    );
    // 平仓结束事件：带净盈亏，供飞书等外推通知订阅
    const basketCode = await this.baskets.codeOf(saved.basketId);
    this.events.emit('lotClosed', {
      symbol: saved.symbol,
      market: saved.market,
      direction: saved.direction,
      quantity: closedQty,
      entryPrice: Number(saved.entryPrice),
      exitPrice: Number(saved.exitPrice ?? fill.price),
      realizedPnl,
      returnPct,
      exitReason,
      strategyInstanceId: saved.strategyInstanceId ?? null,
      basketCode,
      mode,
      ts: Date.now(),
    });
    return saved;
  }

  /** 未完结 Lot 列表（决策循环逐 Lot TP/SL 扫描的输入） */
  async listOpen(market: MarketType, symbol?: string): Promise<PositionLotEntity[]> {
    return this.lotRepo.find({
      where: symbol
        ? { market, symbol, status: 'OPEN' }
        : { market, status: 'OPEN' },
      order: { openedAt: 'ASC' },
    });
  }

  /**
   * 归档「交易所已无该方向持仓、本地却仍是 OPEN」的孤儿 Lot。
   *
   * 用户在交易所手动平仓（或用别的客户端/别的平台平仓）时，本地 Lot 不会被结算——
   * 它们会一直保持 OPEN。曾因此导致启动拦截**永远为真**：
   * 用户明明已经平完仓，却被告知「还有仓位未平」，策略再也启不来。
   *
   * 事实来源是**交易所持仓**，不是本地 Lot 表。
   *
   * ⚠️ 必须按**方向**对账，不能用净持仓：本平台是双向 hedge 模式，
   * 多空持仓可同时存在（锁仓）。多 0.04 + 空 0.02 的净持仓是 +0.02 > 0，
   * 若按「净持仓为正 = 没有空头」归档，会把交易所真实存在的空头仓位
   * 全部误归档——本地从此不再跟踪它们（无 TP/SL、无出场管理），
   * 而交易所仓位还在，账面对不上。曾实际发生（2026-09-28）。
   *
   * @param exchange 交易所**分方向**持仓数量（绝对值，≥0）
   */
  async reconcileOrphanLots(
    market: MarketType,
    symbol: string,
    exchange: { longQty: number; shortQty: number },
  ): Promise<number> {
    const open = await this.lotRepo.find({ where: { market, symbol, status: 'OPEN' } });
    if (open.length === 0) return 0;

    // 只在「交易所该方向持仓为 0」时归档该方向的 Lot；
    // 数量不一致不处理（保守，避免误归档）。
    const orphans = open.filter((l) =>
      l.direction === 'LONG' ? exchange.longQty <= 0 : exchange.shortQty <= 0,
    );
    if (orphans.length === 0) return 0;

    const now = new Date();
    for (const lot of orphans) {
      lot.status = 'CLOSED';
      lot.closedAt = now;
      lot.exitReason = 'MANUAL';
      // 交易所已无此仓位，没有真实平仓价可依：按 0 盈亏归档（宁可不算，不要瞎算）
      lot.closedQuantity = Number(lot.quantity);
      lot.realizedPnl = 0;
      lot.returnPct = 0;
    }
    await this.lotRepo.save(orphans);
    for (const lot of orphans) {
      await this.baskets.onLotSettled(lot.basketId);
    }
    this.logger.warn(
      `归档 ${orphans.length} 个孤儿 Lot（交易所持仓 多 ${exchange.longQty} / 空 ${exchange.shortQty}，本地在该方向已无对应仓位）`,
    );
    return orphans.length;
  }

  /**
   * 接管该交易对下**无归属**的未完结仓位单（P2 多实例）。
   *
   * 启动实例时（adoptExisting），把「实例标识为空」的历史/遗留 Lots
   * 显式划归本实例——这是「重启后自动接管」与「手动仓归策略管」的实现基础。
   * 已归属**其他实例**的 Lot 不动（那是别人的篮子）。
   */
  async claimUnassigned(market: MarketType, symbol: string, instanceId: string): Promise<number> {
    const lots = await this.lotRepo.find({
      where: { market, symbol, status: 'OPEN', strategyInstanceId: IsNull() },
    });
    if (lots.length === 0) return 0;
    for (const lot of lots) lot.strategyInstanceId = instanceId;
    await this.lotRepo.save(lots);
    return lots.length;
  }

  /** 全量 Lot（含 CLOSED/CANCELLED）：订单页按 Lot 分组、对账用，按开仓时间倒序 */
  async listAll(market: MarketType, symbol?: string): Promise<PositionLotEntity[]> {
    return this.lotRepo.find({
      where: symbol ? { market, symbol } : { market },
      order: { openedAt: 'DESC' },
    });
  }

  /**
   * 近 N 日的**已实现盈亏日历**：按自然日（Asia/Shanghai）聚合已平仓 Lot 的 realizedPnl。
   *
   * 用 Lot.realizedPnl 而非 exchange income——demo/testnet 的 income 不回报 REALIZED_PNL，
   * 只有 income 会漏掉全部价格盈亏。Lot 由成交推导，任何环境都可靠，且与篮子「已实现」同口径。
   * 不含资金费（Funding）——那是独立的持仓成本，不计入交易已实现盈亏。
   */
  async realizedPnlByDay(days: number): Promise<DailyRealizedPnl[]> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (Math.max(1, Math.floor(days)) - 1));
    const rows = await this.lotRepo.query(
      `SELECT to_char(date_trunc('day', "closedAt" AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS date,
              SUM("realizedPnl") AS pnl,
              COUNT(*) AS count
       FROM position_lots
       WHERE status = 'CLOSED' AND "realizedPnl" IS NOT NULL AND "closedAt" >= $1
       GROUP BY 1 ORDER BY 1 ASC`,
      [since.toISOString()],
    );
    return (rows as Array<{ date: string; pnl: string | number; count: string | number }>).map(
      (r) => ({
        date: String(r.date),
        realizedPnl: Number(r.pnl ?? 0),
        trades: Number(r.count ?? 0),
      }),
    );
  }

  // countOpenByDirection（按方向计数）已移除：它只为已删的决策引擎
  // MAX_OPEN_LOTS_PER_DIRECTION 检查服务，层数上限现在由策略自己管。

  /**
   * 取同方向**最早**的未完结 Lot（FIFO）。
   *
   * 用于成交对账：平仓单（reduceOnly）在下单时没记 lotId 时，
   * 按 FIFO 归集到最早的那一笔，保证盈亏能结算而不至于永远悬空。
   */
  async findOldestOpenLot(
    market: MarketType,
    symbol: string,
    direction: LotDirection,
  ): Promise<PositionLotEntity | null> {
    return this.lotRepo.findOne({
      where: { market, symbol, direction, status: 'OPEN' },
      order: { openedAt: 'ASC' },
    });
  }

  /** 取一个 OPEN 的 Lot（手动平仓目标校验） */
  async getOpenLot(lotId: string): Promise<PositionLotEntity | null> {
    return this.lotRepo.findOne({ where: { id: lotId, status: 'OPEN' } });
  }

  /**
   * 按开仓订单查 Lot。
   *
   * 策略开仓后需要立刻拿回「我刚建的那个仓」的 id（用于后续独立平仓）；
   * 真实成交延迟时可能查不到（Lot 由对账任务补建），调用方须容忍 null。
   */
  async findByOpenOrderId(openOrderId: string): Promise<PositionLotEntity | null> {
    return this.lotRepo.findOne({ where: { openOrderId } });
  }

  // checkTpSl（逐 Lot 止盈止损扫描）已移除：平台不再扫描逐层止盈止损，
  // 出场完全由策略负责（马丁网格用篮子追踪止盈）。
  // Lot 上的 stopLossPct / takeProfitPct 因此以 0 落库表示「关闭」。

  toDTO(lot: PositionLotEntity, currentPrice?: number) {
    const entryPrice = Number(lot.entryPrice);
    const unrealizedPnl =
      lot.status === 'OPEN' && currentPrice && currentPrice > 0
        ? Number(
            (
              (lot.direction === 'LONG'
                ? currentPrice - entryPrice
                : entryPrice - currentPrice) * Number(lot.quantity) -
              Number(lot.entryFeeUsdt)
            ).toFixed(8),
          )
        : null;

    return {
      id: lot.id,
      market: lot.market,
      symbol: lot.symbol,
      direction: lot.direction,
      basketId: lot.basketId ?? null,
      openOrderId: lot.openOrderId,
      closeOrderId: lot.closeOrderId,
      quantity: Number(lot.quantity),
      closedQuantity: Number(lot.closedQuantity),
      entryPrice,
      entryFeeUsdt: Number(lot.entryFeeUsdt),
      exitPrice: lot.exitPrice === null ? null : Number(lot.exitPrice),
      exitFeeUsdt: lot.exitFeeUsdt === null ? null : Number(lot.exitFeeUsdt),
      status: lot.status,
      exitReason: lot.exitReason,
      realizedPnl: lot.realizedPnl === null ? null : Number(lot.realizedPnl),
      returnPct: lot.returnPct === null ? null : Number(lot.returnPct),
      unrealizedPnl,
      openedAt: lot.openedAt.toISOString(),
      closedAt: lot.closedAt ? lot.closedAt.toISOString() : null,
    };
  }
}
