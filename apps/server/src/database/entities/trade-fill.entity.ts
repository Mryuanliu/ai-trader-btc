import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 成交流水 */
@Entity('trade_fills')
export class TradeFillEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  orderId: string;

  @Column({ length: 32, default: '' })
  symbol: string;

  @Column({ type: 'float8', default: 0 })
  price: number;

  @Column({ type: 'float8', default: 0 })
  quantity: number;

  @Column({ type: 'float8', default: 0 })
  fee: number;

  @Column({ length: 16, default: 'USDT' })
  feeAsset: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  filledAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
