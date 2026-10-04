import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 逐笔成交（aggTrade）历史。event-driven 撮合引擎的**主时间轴**：
 * 用它根除「每 bar 每 STOP 只触发一次」的失真（方案 A4 第 40 行 / A3）。
 *
 * 语义与 Binance USDT-M `/fapi/v1/aggTrades` 一致：
 * - `a` aggTradeId（全局自增，唯一）
 * - `p` 成交价、`q` 数量（合约张数）、`Q` 名义 USDT
 * - `T` 成交时间（ms）、`m` 买方是否为 maker（true → 主动卖 / taker sell）
 *
 * 冷热分层策略：热数据（近 1 年）落 DB；冷归档走 data.binance.vision 月度 zip（脚本外置）。
 * 这里 `(symbol, market, tradeTime)` 建复合索引以支撑按窗回放。
 */
@Entity('market_agg_trades')
@Index('IDX_market_agg_trades_unique', ['symbol', 'market', 'aggTradeId'], { unique: true })
@Index('IDX_market_agg_trades_ts', ['symbol', 'market', 'tradeTime'])
export class MarketAggTradeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  @Column({ type: 'bigint' })
  aggTradeId: number;

  @Column({ type: 'bigint' })
  tradeTime: number;

  @Column({ type: 'float8' })
  price: number;

  @Column({ type: 'float8' })
  qty: number;

  @Column({ type: 'float8', default: 0 })
  quoteQty: number;

  /** 买方是否为 maker：true → 主动方是卖（taker sell），false → 主动方是买 */
  @Column({ type: 'boolean', default: false })
  isBuyerMaker: boolean;

  /** 该聚合笔覆盖的第一/最后一笔原始 trade id（可选，用于对账） */
  @Column({ type: 'bigint', nullable: true })
  firstId: number | null;

  @Column({ type: 'bigint', nullable: true })
  lastId: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
