import type { BacktestRunKind, Timeframe } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 回测运行留存（P0+）。
 *
 * 每次「单次回测 / 稳健性研究 / 参数扫描」落一行，保存完整结果 JSON + 关键摘要列，
 * 让前端「回测台 · 历史」能回看/对比多次运行、验证闸门结论是否随区间漂移。
 *
 * 数值列用 `double precision`：既能让 epoch 毫秒（~1.7e12，< 2^53）安全精确表示，
 * 又能被 TypeORM 直接映射成 JS number，省掉 bigint→string 的转换负担。
 */
@Entity('backtest_runs')
@Index('IDX_backtest_runs_created_at', ['createdAt'])
@Index('IDX_backtest_runs_strategy_symbol', ['strategyName', 'symbol'])
export class BacktestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** 用户自定义备注（可空） */
  @Column({ type: 'varchar', length: 128, nullable: true })
  label: string | null;

  @Column({ type: 'varchar', length: 16 })
  kind: BacktestRunKind;

  @Column({ type: 'varchar', length: 64 })
  strategyName: string;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 8 })
  interval: Timeframe;

  @Column({ type: 'double precision' })
  from: number;

  @Column({ type: 'double precision' })
  to: number;

  @Column({ type: 'double precision' })
  initialCapital: number;

  /** 完整结果：single→BacktestReport；research→ResearchResult；sweep→SweepResult */
  @Column({ type: 'jsonb' })
  report: unknown;

  @Column({ type: 'double precision', nullable: true })
  totalReturnPct: number | null;

  @Column({ type: 'double precision', nullable: true })
  sharpe: number | null;

  @Column({ type: 'double precision', nullable: true })
  oosSharpe: number | null;

  /** Deflated Sharpe（0~1 概率），null 表示该次未算闸门 */
  @Column({ type: 'double precision', nullable: true })
  dsr: number | null;
}
