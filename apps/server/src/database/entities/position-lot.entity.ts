import {
  LotDirection,
  LotExitReason,
  LotStatus,
  MarketType,
} from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 仓位单（Position Lot）：每笔开仓订单对应一个独立仓位单。
 *
 * 核心语义（用户拍板，2026-08-31）：
 * - 1 开仓订单 ↔ 1 Lot ↔ 1 平仓订单，平仓必须全量平掉 Lot 数量，禁止部分平仓
 * - 每个 Lot 独立止盈止损（entryPrice 各异），触发即平该 Lot，出场全量了结
 * - Lot 状态 OPEN→CLOSED 才算完结，盈亏在完结时落定（realizedPnl 含双边手续费）
 * - 现货/合约共用本表，靠 market 区分；合约 hedge mode 下多空 Lot 可共存
 */
@Entity('position_lots')
@Index('IDX_lots_market_symbol_status', ['market', 'symbol', 'status'])
@Index('IDX_lots_open_order', ['openOrderId'])
export class PositionLotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  market: MarketType;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  /** 仓位方向：现货恒 LONG；合约 hedge 下 LONG/SHORT 可共存（锁仓） */
  @Column({ type: 'varchar', length: 8 })
  direction: LotDirection;

  /** 开仓订单（1:1，唯一） */
  @Column({ type: 'uuid' })
  openOrderId: string;

  /** 平仓订单（1:1；NULL = 持仓中） */
  @Column({ type: 'uuid', nullable: true })
  closeOrderId: string | null;

  /** 开仓数量（净到账口径） */
  @Column({ type: 'decimal', precision: 28, scale: 10 })
  quantity: number;

  /** 异常了结时的实际平掉数量（正常全平 = quantity） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  closedQuantity: number;

  @Column({ type: 'decimal', precision: 28, scale: 10 })
  entryPrice: number;

  /** 开仓手续费（折 USDT，计入本单成本） */
  @Column({ type: 'decimal', precision: 28, scale: 10, default: 0 })
  entryFeeUsdt: number;

  @Column({ type: 'decimal', precision: 28, scale: 10, nullable: true })
  exitPrice: number;

  @Column({ type: 'decimal', precision: 28, scale: 10, nullable: true })
  exitFeeUsdt: number;

  @Column({ type: 'varchar', length: 16 })
  status: LotStatus;

  /** 本单生效的止损比例（开仓时落库快照：hybrid AI 逐单可异，strategy 用全局兜底） */
  @Column({ type: 'decimal', precision: 10, scale: 6 })
  stopLossPct: number;

  /** 本单生效的止盈比例 */
  @Column({ type: 'decimal', precision: 10, scale: 6 })
  takeProfitPct: number;

  @Column({ type: 'varchar', length: 24, nullable: true })
  exitReason: LotExitReason | null;

  /** 完结时落定：净盈亏（毛盈亏 − 双边手续费） */
  @Column({ type: 'decimal', precision: 28, scale: 10, nullable: true })
  realizedPnl: number;

  /** 名义收益率：realizedPnl / (entryPrice × quantity) */
  @Column({ type: 'decimal', precision: 14, scale: 8, nullable: true })
  returnPct: number;

  @Column({ type: 'timestamptz' })
  openedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
