import { Index, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 资金费率：永续合约每 8 小时（UTC 00/08/16）结算一次，回测需按持仓区间累计。
 *
 * 只做只读落库供回测与展示使用，不参与实盘盈亏计算
 * （实盘资金费由交易所直接从钱包扣收，以交易所账单为准）。
 */
@Entity('funding_rates')
@Index(['symbol', 'fundingTime'], { unique: true })
export class FundingRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 32 })
  symbol: string;

  /** 结算时间（毫秒时间戳） */
  @Column({ type: 'bigint' })
  fundingTime: number;

  /** 费率，小数形式（0.0001 = 0.01%）；正=多头付空头 */
  @Column({ type: 'float8' })
  rate: number;

  /** 结算时的标记价格；部分数据源不返回 */
  @Column({ type: 'float8', nullable: true })
  markPrice: number | null;
}
