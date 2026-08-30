import { DEFAULT_MARKET, MarketType, Timeframe } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * K 线表按 market 维度隔离现货与合约。
 *
 * 现货与合约同标的的 K 线时间轴一致但价格存在基差，必须分开存储，
 * 否则合约行情会覆盖现货历史，导致现货回测结果失真。
 */
@Entity('market_candles')
// 索引名显式指定：与迁移 1700000004000-FuturesMarket 保持一致，
// 否则 synchronize 会另行生成哈希命名的同义索引，造成重复索引
@Index('IDX_market_candles_unique', ['symbol', 'market', 'interval', 'openTime'], { unique: true })
@Index('IDX_market_candles_market', ['market'])
export class MarketCandleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

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
