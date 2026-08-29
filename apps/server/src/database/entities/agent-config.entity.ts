import { DEFAULT_AGENT_CONFIG, RunMode, Timeframe } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Agent 配置（单 Agent 版本，取第一条记录） */
@Entity('agent_configs')
export class AgentConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 64, default: DEFAULT_AGENT_CONFIG.name })
  name: string;

  @Column({ default: DEFAULT_AGENT_CONFIG.enabled })
  enabled: boolean;

  @Column({ length: 32, default: DEFAULT_AGENT_CONFIG.symbol })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_AGENT_CONFIG.timeframe })
  timeframe: Timeframe;

  @Column({ default: DEFAULT_AGENT_CONFIG.decisionIntervalSec })
  decisionIntervalSec: number;

  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.mode })
  mode: RunMode;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  enabledExchanges: string[];

  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.positionPct })
  positionPct: number;

  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.minConfidence })
  minConfidence: number;

  @Column({ length: 64, default: DEFAULT_AGENT_CONFIG.model })
  model: string;

  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.temperature })
  temperature: number;

  @Column({ default: DEFAULT_AGENT_CONFIG.maxTokens })
  maxTokens: number;

  @Column({ type: 'text', default: DEFAULT_AGENT_CONFIG.systemPrompt })
  systemPrompt: string;

  // ---------------- 风控 ----------------
  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.maxOrderAmount })
  maxOrderAmount: number;

  @Column({ default: DEFAULT_AGENT_CONFIG.maxDailyOrders })
  maxDailyOrders: number;

  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.maxDrawdownPct })
  maxDrawdownPct: number;

  @Column({ default: DEFAULT_AGENT_CONFIG.minOrderIntervalSec })
  minOrderIntervalSec: number;

  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.dailyLossLimit })
  dailyLossLimit: number;

  // ---------------- 运行态 ----------------
  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastDecisionId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
