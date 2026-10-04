import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 强平成交（forceOrder / liquidation）。
 *
 * Binance 无历史 REST 查询，只有 WS `<symbol>@forceOrder`；本表**先建壳**，
 * 待 P1b 引入 WS 采集器后填充。event-driven 引擎在**没数据时仍按 markPrice ×
 * maintenanceMarginRatio 主动模拟强平**（方案 A4 第 42 行），本表用于**对账校验**
 * 「模拟强平时机是否与市场实际强平接近」。
 */
@Entity('market_liquidations')
@Index('IDX_market_liquidations_ts', ['symbol', 'market', 'ts'])
export class MarketLiquidationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  @Column({ type: 'bigint' })
  ts: number;

  /** 被强平的头寸方向：LONG 被平 → 市场卖出；SHORT 被平 → 市场买入 */
  @Column({ length: 8 })
  side: 'LONG' | 'SHORT';

  @Column({ type: 'float8' })
  price: number;

  @Column({ type: 'float8' })
  qty: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
