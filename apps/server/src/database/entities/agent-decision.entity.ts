import {
  BlockingReasonCode,
  DecisionAction,
  DecisionDiagnostics,
  DecisionInputSnapshot,
  DecisionLane,
  DEFAULT_MARKET,
  MarketType,
} from '@ai-trader/shared';
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

  /**
   * 市场类型：现货/合约。
   * 两市场共用本表，不隔离会让合约决策混入现货决策列表与统计口径，
   * 且二者的持仓语义（现货成本均价 vs 合约净持仓）不可互相解释。
   */
  @Column({ type: 'varchar', length: 8, default: DEFAULT_MARKET })
  market: MarketType;

  @Column({ type: 'varchar', length: 8 })
  action: DecisionAction;

  @Column({ type: 'float8', default: 0 })
  confidence: number;

  /**
   * 接近度 0~1：当前倾向已达到触发所需的百分比。
   * 观望时仍有效——proximity=0.76 表示「已达 76%，还差 24%」，
   * 用于区分「差一点就开仓」与「差得远」，解决 HOLD 时 confidence 恒为 0 的信息丢失问题。
   */
  @Column({ type: 'float8', nullable: true })
  proximity: number | null;

  @Column({ type: 'text', default: '' })
  reason: string;

  @Column({ type: 'text', nullable: true })
  riskNotes: string | null;

  /**
   * 阻塞原因码：为什么没开单/没下单（可枚举，便于聚合 Top 统计）。
   * 仅在不产生 BUY/SELL 或被拦截时有值。见 BlockingReasonCode。
   */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  blockingReason: BlockingReasonCode | null;

  /**
   * 决策诊断详情：信号贡献度、达标差距、触发阈值等。
   * jsonb 存储，仅在决策落库时计算，不进热路径。
   */
  @Column({ type: 'jsonb', nullable: true })
  diagnostics: DecisionDiagnostics | null;

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

  /**
   * 决策链路：strategy=纯策略；hybrid=AI 上下文 + 策略执行。
   * 注：原 'llm'（AI 直出买卖）链路已移除，默认值同步改为 strategy。
   * 存量数据若残留 'llm'，读取时归一为 strategy（见 agent-engine/agent.controller）。
   */
  @Column({ type: 'varchar', length: 16, default: 'strategy' })
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
