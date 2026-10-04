import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 标记价格历史（markPrice / indexPrice），来自 `/fapi/v1/premiumIndex`（当前）或
 * data.binance.vision 的 markPrice 快照。粒度 1m/3s 视数据源而定。
 *
 * 用途（方案 A4/A5）：
 * - 强平判定：`equity(markPrice) < maintenanceMargin(position, tier)`
 * - funding 结算金额：`fundingRate × markPrice × netPosition`
 * - 未实现盈亏按 markPrice 计算，不再等同 bar.close（现 vectorized 引擎的已知失真）
 */
@Entity('market_mark_prices')
@Index('IDX_market_mark_prices_unique', ['symbol', 'market', 'ts'], { unique: true })
@Index('IDX_market_mark_prices_ts', ['symbol', 'market', 'ts'])
export class MarketMarkPriceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  /** 快照时间（ms） */
  @Column({ type: 'bigint' })
  ts: number;

  @Column({ type: 'float8' })
  markPrice: number;

  @Column({ type: 'float8', nullable: true })
  indexPrice: number | null;

  /** 下一周期预测费率（快照附带，便于对齐） */
  @Column({ type: 'numeric', precision: 20, scale: 12, nullable: true })
  lastFundingRate: string | null;

  /** 下次结算时间（ms） */
  @Column({ type: 'bigint', nullable: true })
  nextFundingTime: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
