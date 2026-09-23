import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LotDirection, LotExitReason, MarketType, settleLotPnl } from '@ai-trader/shared';
import { OrderEntity } from '../database/entities/order.entity';
import { PositionLotEntity } from '../database/entities/position-lot.entity';

@Injectable()
export class LotService {
  private readonly logger = new Logger(LotService.name);

  constructor(
    @InjectRepository(PositionLotEntity)
    private readonly lotRepo: Repository<PositionLotEntity>,
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
    this.logger.log(
      `Lot 建仓 ${order.market} ${direction} ${fill.quantity} ${order.symbol} @ ${fill.price}`,
    );
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
  }): Promise<PositionLotEntity | null> {
    const { lotId, closeOrderId, fill, exitReason } = params;
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
    this.logger.log(
      `Lot 结算 ${lot.market} ${lot.direction} ${lot.symbol} ${exitReason}: pnl=${realizedPnl} (${(returnPct * 100).toFixed(2)}%)`,
    );
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

  /** 全量 Lot（含 CLOSED/CANCELLED）：订单页按 Lot 分组、对账用，按开仓时间倒序 */
  async listAll(market: MarketType, symbol?: string): Promise<PositionLotEntity[]> {
    return this.lotRepo.find({
      where: symbol ? { market, symbol } : { market },
      order: { openedAt: 'DESC' },
    });
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
