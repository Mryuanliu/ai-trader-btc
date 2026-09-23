import {
  BasketDirection,
  BasketOrigin,
  BasketStatus,
  LotExitReason,
  MarketType,
} from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 篮子（Basket）：一次「建仓 → 全部了结」的完整周期，篮子下挂着若干仓位单（Lot）。
 *
 * 为什么要它：马丁网格加层时，中间几层必然是浮亏的，
 * 只看单笔订单的盈亏毫无意义——**只有整轮一起算才知道这一轮赚没赚**。
 * 所以给每一轮建仓发一个编号（如 `BK-20260923-001`），
 * 把该轮所有 Lot 挂到它下面，出场时汇总出「整体盈亏」。
 *
 * 生命周期：
 * 1. 第一层成交（建 Lot）时开一个新篮子（该 symbol 当时没有 OPEN 篮子的话）
 * 2. 后续每层建 Lot 时累加层数 / 数量 / 均价
 * 3. 每个 Lot 被平掉时累加已平数量与盈亏
 * 4. 篮子里所有 Lot 都不再 OPEN 时关闭篮子，落定整体盈亏
 *
 * 注意：篮子归属是**按 symbol 自动归集**的，不区分开仓来源——
 * 策略开的仓和你手动开的仓，只要同属一轮未了结的持仓，就在同一个篮子里。
 * 这与策略「接管已有仓位」的语义一致。
 */
@Entity('baskets')
@Index('IDX_baskets_market_symbol_status', ['market', 'symbol', 'status'])
@Index('IDX_baskets_code', ['code'], { unique: true })
export class BasketEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 人类可读编号，如 BK-20260923-001（按日递增序号） */
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ type: 'varchar', length: 16 })
  market: MarketType;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  /** 篮子方向：单侧金字塔下为 LONG/SHORT；多空共存（双向 carry）时为 MIXED */
  @Column({ type: 'varchar', length: 8 })
  direction: BasketDirection;

  /** 来源：整轮策略建 / 整轮手动 / 混合 */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  origin: BasketOrigin;

  @Column({ type: 'varchar', length: 16 })
  status: BasketStatus;

  /** 层数 = 篮子下挂的 Lot 个数 */
  @Column({ type: 'int', default: 0 })
  layerCount: number;

  /** 累计开仓数量（Σ Lot.quantity，含已平和未平） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  totalQuantity: number;

  /** 开仓均价（按数量加权；用累计口径，不随平仓变化） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  avgEntryPrice: number;

  /** 累计已平数量 */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  closedQuantity: number;

  /** 平仓均价（按已平数量加权；未平完时是部分口径） */
  @Column({ type: 'decimal', precision: 28, scale: 10, nullable: true })
  avgExitPrice: number | null;

  /** 总手续费（开仓 + 平仓，USDT） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  feeTotal: number;

  /**
   * 资金费（持仓费用）：篮子存续期间交易所实际收取/支付的和。
   *
   * 资金费**不产生成交**（每 8 小时独立结算），所以从 fill 里永远算不出来，
   * 必须从交易所 income 流水取。做多做空方向不同，可能为负（成本）或正（收益）。
   */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  fundingFee: number;

  /** 整体盈亏 = Σ Lot.realizedPnl（已含双边手续费） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  realizedPnl: number;

  /**
   * 篮子名义收益率 = realizedPnl / (avgEntryPrice × totalQuantity)。
   *
   * 与单笔 Lot 的 returnPct 同口径，但分母是整轮名义——这才是「这一轮赚了几个点」。
   * 未平完时是浮盈口径估值，仅供参考。
   */
  @Column({ type: 'decimal', precision: 14, scale: 8, nullable: true })
  returnPct: number | null;

  /** 整轮的了结原因（取最后一个平仓 Lot 的原因） */
  @Column({ type: 'varchar', length: 24, nullable: true })
  exitReason: LotExitReason | null;

  @Column({ type: 'timestamptz' })
  openedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
