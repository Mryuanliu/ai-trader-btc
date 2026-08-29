import { AgentConfigShape, DEFAULT_AGENT_CONFIG, RunMode, Timeframe } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Agent 配置（单 Agent 版本，以 key 唯一约束保证只有一行） */
@Entity('agent_configs')
export class AgentConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 配置行唯一键。
   * 单 Agent 版本固定为 'default'，配合唯一索引让 getOrCreate 可以安全并发 upsert。
   */
  @Column({ type: 'varchar', length: 32, default: 'default' })
  @Index('IDX_agent_configs_key', { unique: true })
  key: string;

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

  /** 行情或 LLM 降级时的行为：hold 强制观望（默认）/ signal 沿用兜底信号
   *  @deprecated 已废弃，由 llmFailurePolicy 承接；strategy 链路忽略本字段 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.degradedAction })
  degradedAction: 'hold' | 'signal';

  /** 决策链路开关（hybrid 将在阶段 5 开放） */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.decisionLane })
  decisionLane: AgentConfigShape['decisionLane'];

  /** 仅 llm 链路生效：LLM 失败后的行为 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.llmFailurePolicy })
  llmFailurePolicy: AgentConfigShape['llmFailurePolicy'];

  /** strategy 链路使用的策略 */
  @Column({ type: 'varchar', length: 32, default: DEFAULT_AGENT_CONFIG.strategyName })
  strategyName: string;

  /** 策略专属参数 */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  strategyParams: Record<string, unknown>;

  /** 模拟撮合滑点（bps） */
  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.slippageBps })
  slippageBps: number;

  /** 手续费率（bps） */
  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.feeRateBps })
  feeRateBps: number;

  /** 单一标的持仓市值占总权益上限（百分比） */
  @Column({ type: 'float8', default: DEFAULT_AGENT_CONFIG.maxExposurePct })
  maxExposurePct: number;

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
