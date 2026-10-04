import type { BacktestRunKind, RegimeSummary, Timeframe } from '@ai-trader/shared';
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

  /** PBO（回测过拟合概率 0~1，仅 research 产出） */
  @Column({ type: 'double precision', nullable: true })
  pbo: number | null;

  /** Monte Carlo block bootstrap 回撤 p95（%，仅 research 产出） */
  @Column({ type: 'double precision', nullable: true })
  mcMaxDDp95: number | null;

  /** 参数高原：冠军邻域最大掉幅（%，仅 sweep 产出） */
  @Column({ type: 'double precision', nullable: true })
  plateauScore: number | null;

  /** CPCV OOS 夏普分位 [p5,p25,p50,p75,p95]（仅 research 产出） */
  @Column({ type: 'jsonb', nullable: true })
  cpcvQuantiles: number[] | null;

  /** regime 分层汇总（仅 research 产出，日线历史不足时 null） */
  @Column({ type: 'jsonb', nullable: true })
  regimeSummary: RegimeSummary | null;

  /** 撮合引擎版本（v1=vectorized；P1 起有 event-driven-v2） */
  @Column({ type: 'varchar', length: 32, nullable: true })
  engineVersion: string | null;
}
