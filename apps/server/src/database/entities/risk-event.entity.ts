import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type RiskLevel = 'info' | 'warn' | 'error';

/** 风控事件：限额拦截、熔断、异常 */
@Entity('risk_events')
@Index(['createdAt'])
export class RiskEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32, default: 'limit' })
  type: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'warn' })
  level: RiskLevel;

  @Column({ type: 'text' })
  message: string;

  @Column({ length: 32, default: '' })
  symbol: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  decisionId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
