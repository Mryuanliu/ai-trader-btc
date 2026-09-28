import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 策略运行实例（P2 多实例）。
 *
 * 取代原先「配置表上单个 shouldRun 字段」的做法——那时全局只能有一个实例，
 * 同交易对跑不了第二个策略。
 *
 * 本表承担两件事：
 * 1. **运行意图持久化**：服务重启后据此自动恢复每个实例
 * 2. **实例标识**：`instanceId` 会被写到 Lot 与 Basket 上，用于仓位隔离
 *
 * `instanceId = 策略名:交易对`，例如 `martingale_grid:BTCUSDT`。
 * 这样「同策略不同交易对」和「同交易对不同策略」都能并存。
 */
@Entity('strategy_instances')
@Index('IDX_strategy_instances_key', ['instanceId'], { unique: true })
@Index('IDX_strategy_instances_should_run', ['shouldRun'])
export class StrategyInstanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 实例标识：`策略名:交易对` */
  @Column({ type: 'varchar', length: 128 })
  instanceId: string;

  @Column({ type: 'varchar', length: 64 })
  strategyName: string;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  /** 归一化后的策略参数（JSON） */
  @Column({ type: 'jsonb', nullable: true })
  params: Record<string, unknown> | null;

  /** 重启后是否应自动恢复 */
  @Column({ type: 'boolean', default: false })
  shouldRun: boolean;

  /** 最近一次启动时间 */
  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
