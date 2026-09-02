import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LotDirection,
  LotExitReason,
  MarketType,
  MAX_OPEN_LOTS_PER_DIRECTION,
  checkLotExit,
  settleLotPnl,
} from '@ai-trader/shared';
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
   * TP/SL 参数在开仓时快照落库——hybrid AI 逐单可异，strategy 链路已在调用侧兜底。
   */
  async createFromOpenFill(params: {
    order: OrderEntity;
    fill: { price: number; quantity: number; fee: number };
    stopLossPct: number;
    takeProfitPct: number;
  }): Promise<PositionLotEntity | null> {
    const { order, fill, stopLossPct, takeProfitPct } = params;
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
      stopLossPct,
      takeProfitPct,
      openedAt: new Date(),
    });
    const saved = await this.lotRepo.save(lot);
    this.logger.log(
      `Lot 建仓 ${order.market} ${direction} ${fill.quantity} ${order.symbol} @ ${fill.price} (SL ${(stopLossPct * 100).toFixed(2)}%/TP ${(takeProfitPct * 100).toFixed(2)}%)`,
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

  /** 指定方向的未完结数量（MAX_OPEN_LOTS 检查用） */
  async countOpenByDirection(
    market: MarketType,
    symbol: string,
    direction: LotDirection,
  ): Promise<number> {
    return this.lotRepo.count({ where: { market, symbol, direction, status: 'OPEN' } });
  }

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
   * 逐 Lot TP/SL 判定（纯函数 checkLotExit，回测同口径）。
   * @param price 当前标记价（现货现价 / 合约 markPrice）
   * @returns 触发出场的 Lot 及原因；未触发返回空
   */
  async checkTpSl(
    market: MarketType,
    symbol: string,
    price: number,
  ): Promise<Array<{ lot: PositionLotEntity; reason: LotExitReason }>> {
    const open = await this.listOpen(market, symbol);
    const triggered: Array<{ lot: PositionLotEntity; reason: LotExitReason }> = [];
    for (const lot of open) {
      const hit = checkLotExit({
        entryPrice: Number(lot.entryPrice),
        direction: lot.direction,
        stopLossPct: Number(lot.stopLossPct),
        takeProfitPct: Number(lot.takeProfitPct),
        price,
      });
      if (hit) triggered.push({ lot, reason: hit });
    }
    return triggered;
  }

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
      stopLossPct: Number(lot.stopLossPct),
      takeProfitPct: Number(lot.takeProfitPct),
      exitReason: lot.exitReason,
      realizedPnl: lot.realizedPnl === null ? null : Number(lot.realizedPnl),
      returnPct: lot.returnPct === null ? null : Number(lot.returnPct),
      unrealizedPnl,
      openedAt: lot.openedAt.toISOString(),
      closedAt: lot.closedAt ? lot.closedAt.toISOString() : null,
    };
  }
}
