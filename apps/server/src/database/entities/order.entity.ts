import {
  DEFAULT_MARKET,
  Environment,
  ExchangeCode,
  MarketType,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
  PositionSide,
  RunMode,
} from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('orders')
@Index(['symbol', 'createdAt'])
/**
 * 虚拟账户推导（按 mode+status 聚合全部成交单）与今日笔数统计
 * （按 mode+status 过滤后按 createdAt 计数）都命中这个索引。
 */
@Index('IDX_orders_mode_status_created', ['mode', 'status', 'createdAt'])
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  exchange: ExchangeCode;

  /**
   * 市场类型：现货/合约。
   * 现货持仓可由成交明细推导，合约持仓以交易所 positionRisk 为权威，
   * 二者口径不同，统计时必须按 market 隔离，否则合约单会被算进现货持仓。
   */
  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  @Column({ type: 'varchar', length: 16, default: 'testnet' })
  environment: Environment;

  @Column({ type: 'varchar', length: 16, default: 'dry_run' })
  mode: RunMode;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8 })
  side: OrderSide;

  /**
   * 订单类型。
   *
   * 长度 24 是为了容纳条件单：`STOP_MARKET`(11) / `TAKE_PROFIT_MARKET`(18)。
   * 原先的 varchar(8) 只够 MARKET/LIMIT，挂网格单会直接报
   * "value too long for type character varying(8)"。
   */
  @Column({ type: 'varchar', length: 24 })
  type: OrderType;

  @Column({ type: 'float8', default: 0 })
  price: number;

  /**
   * 条件单触发价（STOP_MARKET / TAKE_PROFIT_MARKET）。
   *
   * 网格层的「挂单」靠它表达：策略挂出后订单停在 NEW，
   * 价格触及由交易所触发成交，随后由对账任务补记成交与 Lot。
   * 市价单为 0。
   */
  @Column({ type: 'float8', default: 0 })
  stopPrice: number;

  @Column({ type: 'float8', default: 0 })
  quantity: number;

  @Column({ type: 'float8', default: 0 })
  quoteAmount: number;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'NEW' })
  status: OrderStatus;

  @Column({ type: 'float8', default: 0 })
  filledQuantity: number;

  @Column({ type: 'float8', default: 0 })
  filledPrice: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  exchangeOrderId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientOrderId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  source: OrderSource;

  /** 合约杠杆倍数（下单时实际生效值）；现货恒为 0 */
  @Column({ type: 'int', default: 0 })
  leverage: number;

  /** 合约持仓方向 LONG/SHORT；现货为 null */
  @Column({ type: 'varchar', length: 8, nullable: true })
  positionSide: PositionSide | null;

  /** 是否为只平仓单（反手信号的第一跳） */
  @Column({ default: false })
  reduceOnly: boolean;

  /**
   * 目标仓位单（Lot）ID：仅平仓单有值（下单时精确记录要平掉哪个 Lot）。
   *
   * 用途：成交对账（syncPendingFills）用它**精确**结算，避免 demo 异步成交
   * 走兜底时用 FIFO 猜最老 Lot 而结错仓。开仓单为 null。
   */
  @Index('IDX_orders_lotId')
  @Column({ type: 'uuid', nullable: true })
  lotId: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
