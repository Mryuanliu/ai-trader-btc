import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 历史资金费率（每 8h UTC 结算一次），Binance USDT-M `/fapi/v1/fundingRate`。
 *
 * 用于方案 A5：event-driven 引擎按 `fundingRate × markPrice × netPosition` 每 8h 精确入账，
 * 而非当前 vectorized 引擎的「按 bar 时长分摊常数 fundingPctPer8h」——后者是主要失真源之一。
 *
 * 表名与旧现货 `funding_rates`（已随 DropDeadTables 迁移删除）无冲突：
 * 语义不同（本表是**合约历史结算事实**，不是运行时挂账）。
 */
@Entity('market_funding_rates')
@Index('IDX_market_funding_rates_unique', ['symbol', 'fundingTime'], { unique: true })
@Index('IDX_market_funding_rates_symbol', ['symbol', 'fundingTime'])
export class MarketFundingRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  /** 结算时刻（ms，通常 00/08/16 UTC） */
  @Column({ type: 'bigint' })
  fundingTime: number;

  /** 本周期费率（如 0.0001 = 0.01% / 8h） */
  @Column({ type: 'numeric', precision: 20, scale: 12 })
  fundingRate: string;

  /** 结算时的标记价（用于把 rate 折算成 USDT/张） */
  @Column({ type: 'float8', nullable: true })
  markPrice: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
