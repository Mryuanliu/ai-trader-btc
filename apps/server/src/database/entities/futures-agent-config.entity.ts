import { DEFAULT_FUTURES_AGENT_CONFIG, MarginType, RunMode } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 合约链路配置（单行）。
 *
 * 策略托管平台定位下，本表只管**平台侧参数**：账户/交易的基本设置。
 * 原决策引擎相关列（strategyName/strategyParams/decisionLane/minConfidence/
 * maxLeverage/liquidationBufferPct/exitRules/lastDecisionId）已随引擎移除。
 */
@Entity('futures_agent_configs')
export class FuturesAgentConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 单行版本固定 'default'，配合唯一索引让 getOrCreate 可安全并发 upsert */
  @Column({ type: 'varchar', length: 32, default: 'default' })
  @Index('IDX_futures_agent_configs_key', { unique: true })
  key: string;

  @Column({ default: DEFAULT_FUTURES_AGENT_CONFIG.enabled })
  enabled: boolean;

  @Column({ length: 32, default: DEFAULT_FUTURES_AGENT_CONFIG.symbol })
  symbol: string;

  @Column({ type: 'varchar', length: 16, default: DEFAULT_FUTURES_AGENT_CONFIG.mode })
  mode: RunMode;

  /** 保证金占用比例 0~1（不是名义价值比例） */
  @Column({ type: 'float8', default: DEFAULT_FUTURES_AGENT_CONFIG.positionPct })
  positionPct: number;

  /**
   * 开仓杠杆。
   * 平台不设上限——用多少由策略决定（定位是策略托管平台，不做风控）。
   */
  @Column({ type: 'int', default: DEFAULT_FUTURES_AGENT_CONFIG.leverage })
  leverage: number;

  /** 保证金模式：isolated 逐仓（默认）/ cross 全仓 */
  @Column({ type: 'varchar', length: 16, default: DEFAULT_FUTURES_AGENT_CONFIG.marginType })
  marginType: MarginType;

  // ---------------- 运行态 ----------------
  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  // ---------------- 策略运行意图（自动恢复） ----------------
  /**
   * 服务重启前策略是否在跑。
   *
   * 策略运行状态本身在内存里，重启即丢——但持仓单在数据库/交易所里还在，
   * 不恢复的话会出现「界面显示未运行、账户却挂着仓位」的错觉。
   * 服务启动时读到 `true` 就自动重新挂载并接管未平仓。
   */
  @Column({ type: 'boolean', default: false })
  strategyShouldRun: boolean;

  /** 自动恢复时挂载的策略名 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  strategyRunName: string | null;

  /** 自动恢复时使用的策略参数（normalizeParams 前的原始值） */
  @Column({ type: 'jsonb', nullable: true })
  strategyRunParams: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
