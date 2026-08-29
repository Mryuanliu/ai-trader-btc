import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentConfigShape,
  ExitRulesShape,
  clampRiskValue,
  DEFAULT_AGENT_CONFIG,
  ExchangeCode,
  RunMode,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentConfigEntity } from '../database/entities';

/** 配置行唯一键，用于消除 getOrCreate 的并发竞态 */
const AGENT_CONFIG_KEY = 'default';

/** 唯一约束冲突（Postgres 23505 / SQLite SQLITE_CONSTRAINT） */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code;
  const driver = (err as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || driver === '23505';
}

/**
 * 出场规则归一化：比例值须为 (0,1] 区间内有限数值，非法回落 null（关闭）。
 * 读取与写入共用，兜住历史脏数据与直接改库绕过校验的情况。
 */
function normalizeExitRules(raw: unknown, logger?: { warn: (m: string) => void }): ExitRulesShape {
  const close = (label: string, v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const clamped = Math.min(1, n);
    if (clamped !== n && logger) logger.warn(`出场规则 ${label}=${n} 越界，已钳制为 ${clamped}`);
    return clamped;
  };
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    stopLossPct: close('stopLossPct', obj.stopLossPct),
    takeProfitPct: close('takeProfitPct', obj.takeProfitPct),
  };
}

@Injectable()
export class AgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);

  constructor(
    @InjectRepository(AgentConfigEntity)
    private readonly repo: Repository<AgentConfigEntity>,
    private readonly config: ConfigService,
  ) {}

  /**
   * 取唯一配置行。
   *
   * 用带唯一约束的 `key` 列做 upsert，而不是 find + save：
   * 调度器（5s）、概览接口、控制器会并发调用，check-then-act 会插入重复行，
   * 之后永远只操作较旧的那一行。
   */
  async getOrCreate(): Promise<AgentConfigEntity> {
    const row = await this.repo.findOne({ where: { key: AGENT_CONFIG_KEY } });
    if (row) return row;

    const mode = (this.config.get<string>('APP_RUN_MODE', 'dry_run') || 'dry_run') as RunMode;
    // 并发插入时唯一约束会冲突，此时回读即可，不再重复创建
    try {
      const created = await this.repo.save(
        this.repo.create({ key: AGENT_CONFIG_KEY, ...DEFAULT_AGENT_CONFIG, mode }),
      );
      this.logger.log(`已初始化 Agent 配置，运行模式=${mode}`);
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.repo.findOne({ where: { key: AGENT_CONFIG_KEY } });
      if (existing) return existing;
      throw err;
    }
  }

  toShape(entity: AgentConfigEntity): AgentConfigShape {
    return {
      name: entity.name,
      enabled: entity.enabled,
      symbol: entity.symbol,
      timeframe: entity.timeframe,
      decisionIntervalSec: entity.decisionIntervalSec,
      mode: entity.mode,
      enabledExchanges: (entity.enabledExchanges ?? []) as ExchangeCode[],
      positionPct: entity.positionPct,
      minConfidence: entity.minConfidence,
      model: entity.model,
      temperature: entity.temperature,
      maxTokens: entity.maxTokens,
      systemPrompt: entity.systemPrompt,
      // 读取时同样归一化：既能兜住历史脏数据，也能防止直接改库绕过写入校验。
      // 风控各项原先以 >0 作为启用判据，置 0 即失效，这里改为回落到安全下界。
      maxOrderAmount: clampRiskValue('maxOrderAmount', entity.maxOrderAmount),
      maxDailyOrders: clampRiskValue('maxDailyOrders', entity.maxDailyOrders),
      maxDrawdownPct: clampRiskValue('maxDrawdownPct', entity.maxDrawdownPct),
      minOrderIntervalSec: clampRiskValue('minOrderIntervalSec', entity.minOrderIntervalSec),
      dailyLossLimit: clampRiskValue('dailyLossLimit', entity.dailyLossLimit),
      degradedAction: entity.degradedAction === 'signal' ? 'signal' : 'hold',
      // 链路字段读时归一化：兜住历史脏数据，也防直接改库绕过写入校验。
      // hybrid 已在阶段 5 实现，非 strategy/hybrid 一律读为 llm。
      decisionLane:
        entity.decisionLane === 'strategy' || entity.decisionLane === 'hybrid'
          ? entity.decisionLane
          : 'llm',
      llmFailurePolicy:
        entity.llmFailurePolicy === 'strategy' || entity.llmFailurePolicy === 'skip'
          ? entity.llmFailurePolicy
          : 'hold',
      strategyName: entity.strategyName?.trim() || DEFAULT_AGENT_CONFIG.strategyName,
      strategyParams: entity.strategyParams ?? {},
      // 出场规则读时归一化：比例值钳制到 (0,1]，非法回落 null（关闭）
      exitRules: normalizeExitRules(entity.exitRules, this.logger),
      slippageBps: clampRiskValue('slippageBps', entity.slippageBps),
      feeRateBps: clampRiskValue('feeRateBps', entity.feeRateBps),
      maxExposurePct: clampRiskValue('maxExposurePct', entity.maxExposurePct),
    };
  }

  async get(): Promise<AgentConfigShape> {
    return this.toShape(await this.getOrCreate());
  }

  async update(patch: Partial<AgentConfigShape>): Promise<AgentConfigShape> {
    const row = await this.getOrCreate();
    const allowed: (keyof AgentConfigShape)[] = [
      'name',
      'enabled',
      'symbol',
      'timeframe',
      'decisionIntervalSec',
      'mode',
      'enabledExchanges',
      'positionPct',
      'minConfidence',
      'model',
      'temperature',
      'maxTokens',
      'systemPrompt',
      'maxOrderAmount',
      'maxDailyOrders',
      'maxDrawdownPct',
      'minOrderIntervalSec',
      'dailyLossLimit',
      'degradedAction',
      'decisionLane',
      'llmFailurePolicy',
      'strategyName',
      'strategyParams',
      'exitRules',
      'slippageBps',
      'feeRateBps',
      'maxExposurePct',
    ];

    // 风控值一律钳制到安全区间，避免出现「置 0 即关闭风控」的裸奔配置
    const clampTargets: (keyof AgentConfigShape)[] = [
      'maxOrderAmount',
      'maxDailyOrders',
      'maxDrawdownPct',
      'minOrderIntervalSec',
      'dailyLossLimit',
      'positionPct',
      'minConfidence',
      'slippageBps',
      'feeRateBps',
      'maxExposurePct',
    ];

    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      let value: unknown = patch[key];

      if (clampTargets.includes(key) && typeof value === 'number') {
        const clamped = clampRiskValue(key as never, value);
        if (clamped !== value) {
          this.logger.warn(`配置项 ${key} 被钳制: ${value} -> ${clamped}`);
          value = clamped;
        }
      }

      if (key === 'degradedAction' && value !== 'hold' && value !== 'signal') {
        this.logger.warn(`配置项 degradedAction 非法值 ${String(value)}，回落为 hold`);
        value = 'hold';
      }

      // 链路字段写入校验：非法值回落默认并留下 warn，而非让策略引擎拿到脏配置
      if (key === 'decisionLane' && value !== 'llm' && value !== 'strategy' && value !== 'hybrid') {
        this.logger.warn(`配置项 decisionLane 非法值 ${String(value)}，回落为 llm`);
        value = 'llm';
      }
      if (key === 'llmFailurePolicy' && value !== 'hold' && value !== 'strategy' && value !== 'skip') {
        this.logger.warn(`配置项 llmFailurePolicy 非法值 ${String(value)}，回落为 hold`);
        value = 'hold';
      }
      if (key === 'strategyName' && (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))) {
        this.logger.warn(`配置项 strategyName 非法值 ${String(value)}，回落为 trend_following`);
        value = 'trend_following';
      }
           if (
        key === 'strategyParams' &&
        (typeof value !== 'object' || value === null || Array.isArray(value))
      ) {
        this.logger.warn(`配置项 strategyParams 非法值，回落为 {}`);
        value = {};
      }

      // 出场规则写入校验：比例值钳制到 (0,1]，非法回落 null（关闭）
      if (key === 'exitRules' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        this.logger.warn(`配置项 exitRules 非法值，回落为全关`);
        value = { stopLossPct: null, takeProfitPct: null };
      }

      (row as unknown as Record<string, unknown>)[key] = value;
    }

    // 切到实盘会直接影响真实资金，单独记录一条显眼日志便于审计
    if (patch.mode && patch.mode !== row.mode) {
      this.logger.warn(`Agent 运行模式变更: ${row.mode} -> ${patch.mode}`);
    }

    const saved = await this.repo.save(row);
    return this.toShape(saved);
  }

  async setEnabled(enabled: boolean): Promise<AgentConfigShape> {
    return this.update({ enabled });
  }

  async markRun(decisionId: string | null) {
    const row = await this.getOrCreate();
    row.lastRunAt = new Date();
    row.lastDecisionId = decisionId;
    await this.repo.save(row);
  }
}
