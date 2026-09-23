import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 交易所资金流水（income）。
 *
 * 为什么必须单独存这张表：**成交回报（trade_fills）不足以还原真实盈亏**。
 * - 资金费（funding）不产生成交，每 8 小时独立结算，fill 里完全没有
 * - 手续费虽然 fill 里有，但用交易所流水对账才具备权威性
 *
 * 所以盈亏的权威口径是：`REALIZED_PNL + COMMISSION + FUNDING_FEE` 三类流水之和。
 * `tranId` 是交易所流水号，加唯一索引后重复拉取天然幂等。
 */
@Entity('exchange_incomes')
@Index('IDX_incomes_tran', ['tranId'], { unique: true })
@Index('IDX_incomes_time', ['time'])
@Index('IDX_incomes_type_symbol', ['incomeType', 'symbol'])
export class ExchangeIncomeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 交易所流水号（幂等去重键） */
  @Column({ type: 'varchar', length: 48 })
  tranId: string;

  /** 资金类型：REALIZED_PNL / COMMISSION / FUNDING_FEE / … */
  @Column({ type: 'varchar', length: 32 })
  incomeType: string;

  /** 交易对（部分类型如 TRANSFER 为空） */
  @Column({ type: 'varchar', length: 20, default: '' })
  symbol: string;

  /** 计价资产，通常 USDT */
  @Column({ type: 'varchar', length: 12, default: 'USDT' })
  asset: string;

  /** 金额：正为入账，负为出账 */
  @Column({ type: 'decimal', precision: 28, scale: 10 })
  amount: number;

  /** 交易所记录的发生时间 */
  @Column({ type: 'timestamptz' })
  time: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
