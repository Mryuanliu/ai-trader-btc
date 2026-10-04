import { DEFAULT_MARKET, MarketType } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 交易对元数据（tickSize/stepSize/minNotional/杠杆档/margin tier）。
 *
 * 数据源：`/fapi/v1/exchangeInfo`（每 24h 刷一次即可，policy 变动稀有）。
 * 用途（方案 A3/A4/A5）：
 * - 撮合精度：价格按 tickSize 对齐、数量按 stepSize 对齐，最小名义 minNotional 拒单
 * - 强平分层：`marginTier` 里的 `[notionalFloor, maint, cum]` 数组决定维持保证金率
 * - 手续费分档：默认 taker 4bp / maker 2bp（用户实际费率仍从 exchange-account 侧走）
 *
 * 每次拉取覆盖同一条 (symbol, market)，历史用 `fetchedAt` 记录。
 */
@Entity('market_symbol_meta')
@Index('IDX_market_symbol_meta_unique', ['symbol', 'market'], { unique: true })
export class MarketSymbolMetaEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  @Column({ length: 32, default: 'PERPETUAL' })
  contractType: string;

  @Column({ length: 16, default: 'USDT' })
  quoteAsset: string;

  /** 价格最小变动 */
  @Column({ type: 'float8', default: 0.1 })
  tickSize: number;

  /** 数量最小变动（张） */
  @Column({ type: 'float8', default: 0.001 })
  stepSize: number;

  /** 单笔最小名义 USDT */
  @Column({ type: 'float8', default: 100 })
  minNotional: number;

  /** 价格精度（小数位） */
  @Column({ type: 'int', default: 2 })
  pricePrecision: number;

  /** 数量精度（小数位） */
  @Column({ type: 'int', default: 3 })
  quantityPrecision: number;

  /** 最大可用杠杆（默认档） */
  @Column({ type: 'int', default: 20 })
  maxLeverage: number;

  /**
   * 维持保证金分层：Binance `notionalLever[].notional` + `maintMarginRatio` + `cum`。
   * 结构：`[{ notionalFloor, maintMarginRatio, cum }, ...]` 升序。
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  marginTiers: Array<{ notionalFloor: number; maintMarginRatio: number; cum: number }>;

  /** 杠杆分档（可选，供上层选择）：`[{ leverage, notionalCap, maint, cum }, ...]` */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  leverageBrackets: Array<{
    leverage: number;
    notionalCap: number;
    maintMarginRatio: number;
    cum: number;
  }>;

  @Column({ type: 'timestamptz', nullable: true })
  fetchedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
