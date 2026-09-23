import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import type {
  BasketLotItem,
  BasketOrigin,
  BasketSummary,
  LotDirection,
  MarketType,
  OrderSource,
} from '@ai-trader/shared';
import { BasketEntity } from '../database/entities/basket.entity';
import { PositionLotEntity } from '../database/entities/position-lot.entity';
import { IncomeService } from './income.service';

/**
 * 篮子服务：维护「一次建仓 → 全部了结」周期的统计。
 *
 * 为什么需要篮子：马丁网格加层时，中间层必然是浮亏的，
 * 单看某一笔订单的盈亏毫无意义——**只有整轮一起算，才知道这个循环赚没赚**。
 * 本服务负责：开篮子 / 把新层的 Lot 挂上去 / 汇总统计 / 全部平掉后关闭篮子。
 *
 * 归属规则（与策略「接管已有仓位」的语义一致）：
 * 按 `market + symbol` 归集，**不区分开仓来源**——策略开的仓与手动开的仓，
 * 只要同属一轮未了结的持仓，就在同一个篮子里。
 */
@Injectable()
export class BasketService {
  private readonly logger = new Logger(BasketService.name);

  constructor(
    @InjectRepository(BasketEntity)
    private readonly basketRepo: Repository<BasketEntity>,
    @InjectRepository(PositionLotEntity)
    private readonly lotRepo: Repository<PositionLotEntity>,
    private readonly income: IncomeService,
  ) {}

  /** 取该交易对当前的 OPEN 篮子；没有则新建（并分配编号） */
  async resolveOpenBasket(params: {
    market: MarketType;
    symbol: string;
    direction: LotDirection;
  }): Promise<BasketEntity> {
    const existing = await this.basketRepo.findOne({
      where: { market: params.market, symbol: params.symbol, status: 'OPEN' },
      order: { openedAt: 'DESC' },
    });
    if (existing) return existing;

    const saved = await this.basketRepo.save(
      this.basketRepo.create({
        code: await this.nextCode(),
        market: params.market,
        symbol: params.symbol,
        direction: params.direction,
        origin: 'manual',
        status: 'OPEN',
        layerCount: 0,
        totalQuantity: 0,
        avgEntryPrice: 0,
        closedQuantity: 0,
        avgExitPrice: null,
        feeTotal: 0,
        fundingFee: 0,
        realizedPnl: 0,
        returnPct: null,
        exitReason: null,
        openedAt: new Date(),
        closedAt: null,
      }),
    );
    this.logger.log(`篮子开立 ${saved.code} ${params.symbol} ${params.direction}`);
    return saved;
  }

  /**
   * 新层建成：把 Lot 挂到当前篮子上，然后重算统计。
   *
   * `source` 用于推断篮子来源（策略 / 手动 / 混合），因为在篮子内混入手动仓时，
   * 「这一轮是谁在操作」是需要如实呈现的信息。
   */
  async attachLot(lot: PositionLotEntity, source: OrderSource): Promise<void> {
    const basket = await this.resolveOpenBasket({
      market: lot.market,
      symbol: lot.symbol,
      direction: lot.direction,
    });

    lot.basketId = basket.id;
    await this.lotRepo.save(lot);

    // 来源：首笔决定，出现不同类型的来源就标记为混合
    const incoming: BasketOrigin = source === 'strategy' ? 'strategy' : 'manual';
    if (basket.origin !== 'mixed' && basket.origin !== incoming) {
      basket.origin = 'mixed';
      await this.basketRepo.save(basket);
    }

    await this.recompute(basket.id);
  }

  /** Lot 结算后重算篮子（平完最后一层会自动关闭篮子） */
  async onLotSettled(basketId: string | null): Promise<void> {
    if (!basketId) return;
    await this.recompute(basketId);
  }

  /**
   * 从 Lot 全量重算篮子统计。
   *
   * 用「全量重算」而不是「增量累加」：无论平仓顺序、重试、重复回调，
   * 结果都收敛到同一个值，不会因为某次漏加而永久漂移。
   */
  async recompute(basketId: string): Promise<BasketEntity | null> {
    const basket = await this.basketRepo.findOne({ where: { id: basketId } });
    if (!basket) return null;

    const lots = await this.lotRepo.find({
      where: { basketId },
      order: { openedAt: 'ASC' },
    });
    if (lots.length === 0) return basket;

    const num = (v: unknown) => Number(v ?? 0);
    const totalQty = lots.reduce((a, l) => a + num(l.quantity), 0);
    const entryNotional = lots.reduce((a, l) => a + num(l.entryPrice) * num(l.quantity), 0);
    const closed = lots.filter((l) => l.status === 'CLOSED');
    const open = lots.filter((l) => l.status === 'OPEN');
    const closedQty = closed.reduce((a, l) => a + num(l.closedQuantity), 0);
    const exitNotional = closed.reduce((a, l) => a + num(l.exitPrice) * num(l.closedQuantity), 0);
    const realized = closed.reduce((a, l) => a + num(l.realizedPnl), 0);
    const fee =
      lots.reduce((a, l) => a + num(l.entryFeeUsdt), 0) +
      closed.reduce((a, l) => a + num(l.exitFeeUsdt), 0);

    const directions = new Set(lots.map((l) => l.direction));
    basket.direction = directions.size > 1 ? 'MIXED' : lots[0].direction;
    basket.layerCount = lots.length;
    basket.totalQuantity = totalQty;
    basket.avgEntryPrice = totalQty > 0 ? entryNotional / totalQty : 0;
    basket.closedQuantity = closedQty;
    basket.avgExitPrice = closedQty > 0 ? exitNotional / closedQty : null;
    basket.feeTotal = fee;
    basket.realizedPnl = realized;
    basket.returnPct = entryNotional > 0 ? realized / entryNotional : null;

    if (open.length === 0) {
      // 整轮已了结：关闭篮子，落定原因（取最后一笔平仓的原因）
      const last = closed[closed.length - 1];
      basket.status = 'CLOSED';
      basket.closedAt = basket.closedAt ?? last?.closedAt ?? new Date();
      basket.exitReason = last?.exitReason ?? null;

      // 资金费（持仓费用）：不产生成交，只能从交易所资金流水取。
      // 取「篮子存续期间」该交易对的实际收取额——这才是账户真实扣掉的那部分。
      try {
        basket.fundingFee = await this.income.fundingFeeBetween(
          basket.symbol,
          basket.openedAt,
          basket.closedAt,
        );
      } catch (err) {
        this.logger.warn(`篮子 ${basket.code} 资金费取数失败：${(err as Error).message}`);
      }
    }

    return this.basketRepo.save(basket);
  }

  /**
   * 最近的篮子（总览看板用），按开仓时间倒序，含各层明细。
   *
   * `priceOf` 提供现价用于估算未平部分的浮盈——篮子未结束时 realizedPnl 恒为 0，
   * 不给浮盈的话「整体盈亏」列会一直显示 0，看不出这一轮在赚还是在亏。
   */
  async listRecent(
    limit: number,
    market: MarketType,
    priceOf?: (symbol: string) => number,
  ): Promise<BasketSummary[]> {
    const baskets = await this.basketRepo.find({
      where: { market },
      order: { openedAt: 'DESC' },
      take: limit,
    });
    if (baskets.length === 0) return [];

    const lots = await this.lotRepo.find({
      where: baskets.map((b) => ({ basketId: b.id })),
      order: { openedAt: 'ASC' },
    });
    const byBasket = new Map<string, PositionLotEntity[]>();
    for (const lot of lots) {
      if (!lot.basketId) continue;
      const arr = byBasket.get(lot.basketId) ?? [];
      arr.push(lot);
      byBasket.set(lot.basketId, arr);
    }

    return baskets.map((b) =>
      this.toSummary(b, byBasket.get(b.id) ?? [], priceOf?.(b.symbol) ?? 0),
    );
  }

  /** 单个篮子详情 */
  async detail(basketId: string, priceOf?: (symbol: string) => number): Promise<BasketSummary | null> {
    const basket = await this.basketRepo.findOne({ where: { id: basketId } });
    if (!basket) return null;
    const lots = await this.lotRepo.find({
      where: { basketId },
      order: { openedAt: 'ASC' },
    });
    return this.toSummary(basket, lots, priceOf?.(basket.symbol) ?? 0);
  }

  /** 篮子实体 + 层列表 → 对外 DTO（含未平浮盈估算） */
  private toSummary(
    basket: BasketEntity,
    lots: PositionLotEntity[],
    price: number,
  ): BasketSummary {
    const num = (v: unknown) => Number(v ?? 0);

    const items: BasketLotItem[] = lots.map((l, i) => ({
      id: l.id,
      layer: i + 1,
      direction: l.direction,
      quantity: num(l.quantity),
      entryPrice: num(l.entryPrice),
      exitPrice: l.exitPrice === null ? null : num(l.exitPrice),
      realizedPnl: l.realizedPnl === null ? null : num(l.realizedPnl),
      returnPct: l.returnPct === null ? null : num(l.returnPct),
      status: l.status,
      exitReason: l.exitReason,
      openOrderId: l.openOrderId,
      closeOrderId: l.closeOrderId,
      openedAt: l.openedAt.toISOString(),
      closedAt: l.closedAt ? l.closedAt.toISOString() : null,
    }));

    // 未平部分的浮动盈亏（毛，不含未发生的手续费）
    let unrealized = 0;
    let openQty = 0;
    if (price > 0) {
      for (const l of lots) {
        if (l.status !== 'OPEN') continue;
        const qty = num(l.quantity);
        openQty += qty;
        const diff = l.direction === 'LONG' ? price - num(l.entryPrice) : num(l.entryPrice) - price;
        unrealized += diff * qty;
      }
    } else {
      openQty = lots
        .filter((l) => l.status === 'OPEN')
        .reduce((a, l) => a + num(l.quantity), 0);
    }

    return {
      id: basket.id,
      code: basket.code,
      symbol: basket.symbol,
      direction: basket.direction,
      origin: basket.origin,
      status: basket.status,
      layerCount: basket.layerCount,
      totalQuantity: num(basket.totalQuantity),
      avgEntryPrice: num(basket.avgEntryPrice),
      closedQuantity: num(basket.closedQuantity),
      avgExitPrice: basket.avgExitPrice === null ? null : num(basket.avgExitPrice),
      realizedPnl: num(basket.realizedPnl),
      fundingFee: num(basket.fundingFee),
      returnPct: basket.returnPct === null ? null : num(basket.returnPct),
      openQuantity: openQty,
      unrealizedPnl: unrealized,
      exitReason: basket.exitReason,
      openedAt: basket.openedAt.toISOString(),
      closedAt: basket.closedAt ? basket.closedAt.toISOString() : null,
      lots: items,
    };
  }

  /**
   * 生成篮子编号：`BK-YYYYMMDD-NNN`（按日递增）。
   *
   * 同日并发开篮子的概率极低（单 symbol 单轮），但仍做冲突规避，
   * 因为 `code` 上有唯一索引——撞了会直接抛错，宁可多查一次。
   */
  private async nextCode(): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `BK-${day}-`;
    const used = await this.basketRepo.count({ where: { code: Like(`${prefix}%`) } });
    for (let i = 0; i < 20; i += 1) {
      const code = `${prefix}${String(used + i + 1).padStart(3, '0')}`;
      const clash = await this.basketRepo.findOne({ where: { code } });
      if (!clash) return code;
    }
    // 极端情况兜底：加时间戳后缀，保证唯一
    return `${prefix}${Date.now().toString().slice(-6)}`;
  }
}
