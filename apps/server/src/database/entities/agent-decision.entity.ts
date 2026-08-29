import { DecisionAction, DecisionInputSnapshot, DecisionLane } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 一次完整决策链条记录 */
@Entity('agent_decisions')
@Index(['symbol', 'createdAt'])
@Index(['lane', 'createdAt'])
export class AgentDecisionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  agentId: string;

  @Column({ length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 8 })
  action: DecisionAction;

  @Column({ type: 'float8', default: 0 })
  confidence: number;

  @Column({ type: 'text', default: '' })
  reason: string;

  @Column({ type: 'text', nullable: true })
  riskNotes: string | null;

  /** 输入快照：行情、指标、信号、新闻、账户 */
  @Column({ type: 'jsonb' })
  inputSnapshot: DecisionInputSnapshot;

  @Column({ type: 'text', default: '' })
  prompt: string;

  @Column({ type: 'text', nullable: true })
  llmRaw: string | null;

  /** 推理模型的思维链（reasoning_content） */
  @Column({ type: 'text', nullable: true })
  llmReasoning: string | null;

  /** 实际响应的模型名 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  llmModel: string | null;

  /** token 用量：{ prompt, completion, total } */
  @Column({ type: 'jsonb', nullable: true })
  llmUsage: { prompt: number; completion: number; total: number } | null;

  @Column({ default: false })
  degraded: boolean;

  @Column({ type: 'text', nullable: true })
  degradeReason: string | null;

  @Column({ default: true })
  riskPassed: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true })
  riskRejectedBy: string | null;

  @Column({ type: 'text', nullable: true })
  riskNote: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  orderId: string | null;

  /** 决策链路：llm=AI 决策；strategy=纯策略决策（llm 链路降级到策略时仍记 llm） */
  @Column({ type: 'varchar', length: 16, default: 'llm' })
  lane: DecisionLane;

  /** 策略链路（或 llm 链路降级到策略）下实际产出决策的策略名 */
  @Column({ type: 'varchar', length: 32, nullable: true })
  strategyName: string | null;

  @Column({ default: 0 })
  latencyMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt: Date;
}
