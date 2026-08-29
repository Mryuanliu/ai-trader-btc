import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentConfigShape,
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
