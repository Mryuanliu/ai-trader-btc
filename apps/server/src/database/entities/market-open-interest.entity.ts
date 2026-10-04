import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Open Interest（未平仓合约）历史。Binance 提供两个源：
 * - `/futures/data/openInterestHist`：5m/15m/30m/1h/2h/4h/6h/12h/1d 粒度、近 30 天
 * - `/fapi/v1/openInterest`：仅当前
 *
 * 因此本表**只能覆盖近端**；更早的历史需要在 30 天窗口内滚动落库（脚本每次拉一段）。
 * 用途（方案 B3）：OI×价格背离作趋势/反转 regime 触发器；容量估算。
 */
@Entity('market_open_interest')
@Index('IDX_market_open_interest_unique', ['symbol', 'market', 'ts'], { unique: true })
@Index('IDX_market_open_interest_ts', ['symbol', 'market', 'ts'])
export class MarketOpenInterestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  /** 采样对齐时间（ms，period 边界） */
  @Column({ type: 'bigint' })
  ts: number;

  /** 未平仓合约张数 */
  @Column({ type: 'float8' })
  openInterest: number;

  /** 名义 USDT 值（= OI × markPrice） */
  @Column({ type: 'float8', default: 0 })
  openInterestValue: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
