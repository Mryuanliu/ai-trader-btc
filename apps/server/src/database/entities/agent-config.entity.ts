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
   *  @deprecated 已废弃，仅保留列以兼容存量数据，新代码不再读取 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.degradedAction })
  degradedAction: 'hold' | 'signal';

  /** 决策链路开关：strategy=纯策略（零 LLM）；hybrid=AI 上下文 + 策略执行 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_AGENT_CONFIG.decisionLane })
  decisionLane: AgentConfigShape['decisionLane'];

  /** 策略使用的策略名（两条链路都由策略执行买卖） */
  @Column({ type: 'varchar', length: 32, default: DEFAULT_AGENT_CONFIG.strategyName })
  strategyName: string;

  /** 策略专属参数 */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  strategyParams: Record<string, unknown>;

  /** 出场规则（止损/止盈）：两条链路均生效，默认全关，显式配置才启用 */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  exitRules: {
    stopLossPct: number | null;
    takeProfitPct: number | null;
  };

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
