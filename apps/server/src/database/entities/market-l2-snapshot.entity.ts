import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 盘口 L2 深度快照（best-N 档）。
 *
 * **注意**：Binance USDT-M **不提供 REST 历史深度查询**，只能通过：
 * 1. WS `<symbol>@depth20@100ms` 实时流 + 自采落库
 * 2. data.binance.vision 的 `daily/spot`/`daily/futures` 归档（部分品种）
 *
 * 本表**先建壳、暂无数据源**：待 P1b 引入 WS 采集器（或第三方）后填充。
 * event-driven 引擎读取到空表时**必须显式拒绝**（不做「无 L2 → 用 close 价」的假想撮合，
 * 那是方案 A6 第 9 条禁止的「回落 vectorized 冒充保真」）。
 */
@Entity('market_l2_snapshots')
@Index('IDX_market_l2_snapshots_unique', ['symbol', 'market', 'ts'], { unique: true })
@Index('IDX_market_l2_snapshots_ts', ['symbol', 'market', 'ts'])
export class MarketL2SnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  /** 快照时间（ms） */
  @Column({ type: 'bigint' })
  ts: number;

  /** [[price, qty], ...] 从高到低 */
  @Column({ type: 'jsonb' })
  bids: Array<[number, number]>;

  /** [[price, qty], ...] 从低到高 */
  @Column({ type: 'jsonb' })
  asks: Array<[number, number]>;

  /** 可选序列号（来自 WS `u` first update id），用于对账 */
  @Column({ type: 'bigint', nullable: true })
  sequence: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
