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

  @Column({ type: 'varchar', length: 8 })
  type: OrderType;

  @Column({ type: 'float8', default: 0 })
  price: number;

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

  @Column({ type: 'varchar', length: 64, nullable: true })
  decisionId: string | null;

  /** 合约杠杆倍数（下单时实际生效值）；现货恒为 0 */
  @Column({ type: 'int', default: 0 })
  leverage: number;

  /** 合约持仓方向 LONG/SHORT；现货为 null */
  @Column({ type: 'varchar', length: 8, nullable: true })
  positionSide: PositionSide | null;

  /** 是否为只平仓单（反手信号的第一跳） */
  @Column({ default: false })
  reduceOnly: boolean;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
