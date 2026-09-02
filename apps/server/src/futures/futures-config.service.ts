import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  clampRiskValue,
  DEFAULT_FUTURES_AGENT_CONFIG,
  ExitRulesShape,
  FuturesAgentConfigShape,
  RunMode,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { FuturesAgentConfigEntity } from '../database/entities';

/** 配置行唯一键，用于消除 getOrCreate 的并发竞态 */
const CONFIG_KEY = 'default';

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code;
  const driver = (err as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || driver === '23505';
}

function normalizeExitRules(raw: unknown): ExitRulesShape {
  const close = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(1, n);
  };
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    stopLossPct: close(obj.stopLossPct),
    takeProfitPct: close(obj.takeProfitPct),
  };
}

/**
 * 合约链路配置。
 *
 * 与现货 AgentConfigService 完全独立：独立开关、独立策略、独立杠杆参数。
 * 关闭合约不会影响现货，反之亦然。
 */
@Injectable()
export class FuturesConfigService {
  private readonly logger = new Logger(FuturesConfigService.name);

  constructor(
    @InjectRepository(FuturesAgentConfigEntity)
    private readonly repo: Repository<FuturesAgentConfigEntity>,
    private readonly config: ConfigService,
  ) {}

  /** 取唯一配置行（带唯一约束的 upsert，避免并发插入重复行） */
  async getOrCreate(): Promise<FuturesAgentConfigEntity> {
    const row = await this.repo.findOne({ where: { key: CONFIG_KEY } });
    if (row) return row;

    const mode = (this.config.get<string>('APP_RUN_MODE', 'dry_run') || 'dry_run') as RunMode;
    try {
      const created = await this.repo.save(
        this.repo.create({
          key: CONFIG_KEY,
          ...DEFAULT_FUTURES_AGENT_CONFIG,
          mode,
        }),
      );
      this.logger.log(`已初始化合约 Agent 配置，运行模式=${mode}`);
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.repo.findOne({ where: { key: CONFIG_KEY } });
      if (existing) return existing;
      throw err;
    }
  }

  /**
   * 读时归一化：兜住历史脏数据与直接改库绕过写入校验的情况。
   * 杠杆必须同时受 leverage 上限与 maxLeverage 天花板双重约束。
   */
  toShape(entity: FuturesAgentConfigEntity): FuturesAgentConfigShape {
    const maxLeverage = Math.round(
      clampRiskValue('maxLeverage', entity.maxLeverage ?? DEFAULT_FUTURES_AGENT_CONFIG.maxLeverage),
    );
    const leverage = Math.round(
      clampRiskValue('leverage', entity.leverage ?? DEFAULT_FUTURES_AGENT_CONFIG.leverage),
    );

    return {
      name: entity.name,
      enabled: entity.enabled,
      symbol: entity.symbol,
      timeframe: entity.timeframe,
      decisionIntervalSec: entity.decisionIntervalSec,
      mode: entity.mode,
      positionPct: clampRiskValue('positionPct', entity.positionPct),
      minConfidence: clampRiskValue('minConfidence', entity.minConfidence),
      // 实际生效杠杆再对 maxLeverage 取一次上限，防止调低 maxLeverage 后存量 leverage 仍然越界
      leverage: Math.min(leverage, maxLeverage),
      maxLeverage,
      marginType: entity.marginType === 'cross' ? 'cross' : 'isolated',
      liquidationBufferPct: clampRiskValue(
        'liquidationBufferPct',
        entity.liquidationBufferPct ?? DEFAULT_FUTURES_AGENT_CONFIG.liquidationBufferPct,
      ),
      decisionLane: entity.decisionLane === 'hybrid' ? 'hybrid' : 'strategy',
      strategyName: entity.strategyName?.trim() || DEFAULT_FUTURES_AGENT_CONFIG.strategyName,
      strategyParams: entity.strategyParams ?? {},
      exitRules: normalizeExitRules(entity.exitRules),
      lastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
    };
  }

  async get(): Promise<FuturesAgentConfigShape> {
    return this.toShape(await this.getOrCreate());
  }

  async update(patch: Partial<FuturesAgentConfigShape>): Promise<FuturesAgentConfigShape> {
    const row = await this.getOrCreate();
    const allowed: (keyof FuturesAgentConfigShape)[] = [
      'name',
      'enabled',
      'symbol',
      'timeframe',
      'decisionIntervalSec',
      'mode',
      'positionPct',
      'minConfidence',
      'leverage',
      'maxLeverage',
      'marginType',
      'liquidationBufferPct',
      'decisionLane',
      'strategyName',
      'strategyParams',
      'exitRules',
    ];

    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      let value: unknown = patch[key];

      if (key === 'leverage' || key === 'maxLeverage') {
        const clamped = Math.round(clampRiskValue(key, value));
        if (clamped !== value) {
          this.logger.warn(`合约配置项 ${key} 被钳制: ${String(value)} -> ${clamped}`);
        }
        value = clamped;
      }

      if (key === 'marginType' && value !== 'isolated' && value !== 'cross') {
        this.logger.warn(`合约配置项 marginType 非法值 ${String(value)}，回落为 isolated`);
        value = 'isolated';
      }

      if (key === 'decisionLane' && value !== 'strategy' && value !== 'hybrid') {
        this.logger.warn(`合约配置项 decisionLane 非法值 ${String(value)}，回落为 strategy`);
        value = 'strategy';
      }

      if (
        key === 'strategyName' &&
        (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))
      ) {
        this.logger.warn(`合约配置项 strategyName 非法值 ${String(value)}，回落为 trend_following`);
        value = 'trend_following';
      }

      if (key === 'exitRules' && (typeof value !== 'object' || value === null)) {
        this.logger.warn('合约配置项 exitRules 非法值，回落为全关');
        value = { stopLossPct: null, takeProfitPct: null };
      }

      (row as unknown as Record<string, unknown>)[key] = value;
    }

    // 杠杆直接决定爆仓风险，单独留一条显眼日志便于审计
    if (patch.leverage !== undefined && patch.leverage !== row.leverage) {
      this.logger.warn(`合约杠杆变更: ${row.leverage} -> ${patch.leverage}`);
    }
    if (patch.mode && patch.mode !== row.mode) {
      this.logger.warn(`合约运行模式变更: ${row.mode} -> ${patch.mode}`);
    }

    const saved = await this.repo.save(row);
    return this.toShape(saved);
  }

  async setEnabled(enabled: boolean): Promise<FuturesAgentConfigShape> {
    return this.update({ enabled });
  }

  /**
   * 推进最后运行时间。
   * 即使本轮决策失败也要调用，否则调度器会判定为到期而每 5 秒重试一次；
   * 退避与熔断由引擎的 nextRetryAt 独立控制。
   */
  async markRun(decisionId: string | null) {
    const row = await this.getOrCreate();
    row.lastRunAt = new Date();
    row.lastDecisionId = decisionId;
    await this.repo.save(row);
  }

  /** 供调度器判断是否到了下一轮（返回实体，含 lastRunAt 与开关） */
  async getEntity(): Promise<FuturesAgentConfigEntity> {
    return this.getOrCreate();
  }
}
