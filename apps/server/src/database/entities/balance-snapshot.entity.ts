import { Environment, ExchangeCode } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('balance_snapshots')
@Index(['exchange', 'asset', 'createdAt'])
/**
 * 补 (source, createdAt) 索引：迁移里已建，但实体若不同步声明，
 * 开发环境的 synchronize=true 会把该索引 DROP 掉，
 * 导致今日盈亏与回撤查询（风控链路每次下单都会跑）退化为全表扫描。
 */
@Index('IDX_balance_snapshots_source', ['source', 'createdAt'])
export class BalanceSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  exchange: ExchangeCode;

  @Column({ type: 'varchar', length: 16, default: 'testnet' })
  environment: Environment;

  @Column({ length: 16 })
  asset: string;

  @Column({ type: 'float8', default: 0 })
  free: number;

  @Column({ type: 'float8', default: 0 })
  locked: number;

  @Column({ type: 'float8', default: 0 })
  total: number;

  /** 折算 USDT 估值快照 */
  @Column({ type: 'float8', default: 0 })
  usdtValue: number;

  /**
   * 余额来源：exchange=交易所实读 / virtual=虚拟账户推导
   * 用于隔离基线，避免切换运行模式时把两种口径的权益混算成虚假盈亏
   */
  @Column({ type: 'varchar', length: 16, default: 'virtual' })
  source: 'virtual' | 'exchange';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
