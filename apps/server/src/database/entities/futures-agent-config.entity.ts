import {
  DEFAULT_FUTURES_AGENT_CONFIG,
  FuturesAgentConfigShape,
  MarginType,
  RunMode,
  Timeframe,
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
 * 合约 Agent 配置（与现货 agent_configs 完全独立）。
 *
 * 独立成表而非给现货配置加 futures 块：合约链路有 enable/strategy/leverage 独立开关，
 * 用户要求「关闭合约不影响现货，反之亦然」，混在一行会让两者的读写互相牵连。
 */
@Entity('futures_agent_configs')
export class FuturesAgentConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 单 Agent 版本固定 'default'，配合唯一索引让 getOrCreate 可安全并发 upsert */
  @Column({ type: 'varchar', length: 32, default: 'default' })
  @Index('IDX_futures_agent_configs_key', { unique: true })
  key: string;

  @Column({ length: 64, default: DEFAULT_FUTURES_AGENT_CONFIG.name })
  name: string;

  @Column({ default: DEFAULT_FUTURES_AGENT_CONFIG.enabled })
  enabled: boolean;

  @Column({ length: 32, default: DEFAULT_FUTURES_AGENT_CONFIG.symbol })
  symbol: string;

  @Column({ type: 'varchar', length: 8, default: DEFAULT_FUTURES_AGENT_CONFIG.timeframe })
  timeframe: Timeframe;

  @Column({ default: DEFAULT_FUTURES_AGENT_CONFIG.decisionIntervalSec })
  decisionIntervalSec: number;

  @Column({ type: 'varchar', length: 16, default: DEFAULT_FUTURES_AGENT_CONFIG.mode })
  mode: RunMode;

  /** 保证金占用比例 0~1（不是名义价值比例） */
  @Column({ type: 'float8', default: DEFAULT_FUTURES_AGENT_CONFIG.positionPct })
  positionPct: number;

  @Column({ type: 'float8', default: DEFAULT_FUTURES_AGENT_CONFIG.minConfidence })
  minConfidence: number;

  /** 开仓杠杆，钳制 1~maxLeverage */
  @Column({ type: 'int', default: DEFAULT_FUTURES_AGENT_CONFIG.leverage })
  leverage: number;

  /** 杠杆硬上限 */
  @Column({ type: 'int', default: DEFAULT_FUTURES_AGENT_CONFIG.maxLeverage })
  maxLeverage: number;

  /** 保证金模式：isolated 逐仓（默认）/ cross 全仓 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_FUTURES_AGENT_CONFIG.marginType })
  marginType: MarginType;

  /** 距强平价低于该比例时禁止加仓 */
  @Column({ type: 'float8', default: DEFAULT_FUTURES_AGENT_CONFIG.liquidationBufferPct })
  liquidationBufferPct: number;

  @Column({ type: 'varchar', length: 16, default: DEFAULT_FUTURES_AGENT_CONFIG.decisionLane })
  decisionLane: FuturesAgentConfigShape['decisionLane'];

  @Column({ type: 'varchar', length: 32, default: DEFAULT_FUTURES_AGENT_CONFIG.strategyName })
  strategyName: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  strategyParams: Record<string, unknown>;

  /** 出场规则（止损/止盈），默认全关，显式配置才启用 */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  exitRules: {
    stopLossPct: number | null;
    takeProfitPct: number | null;
  };

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
