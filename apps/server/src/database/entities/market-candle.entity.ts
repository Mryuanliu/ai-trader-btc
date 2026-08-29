import { Timeframe } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('market_candles')
@Index(['symbol', 'interval', 'openTime'], { unique: true })
export class MarketCandleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8 })
  interval: Timeframe;

  @Index()
  @Column({ type: 'bigint' })
  openTime: number;

  @Column({ type: 'float8', default: 0 })
  open: number;

  @Column({ type: 'float8', default: 0 })
  high: number;

  @Column({ type: 'float8', default: 0 })
  low: number;

  @Column({ type: 'float8', default: 0 })
  close: number;

  @Column({ type: 'float8', default: 0 })
  volume: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
