import {
  Environment,
  ExchangeCode,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
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

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
