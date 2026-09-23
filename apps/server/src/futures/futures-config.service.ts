import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_FUTURES_AGENT_CONFIG, FuturesAgentConfigShape, RunMode } from '@ai-trader/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FuturesAgentConfigEntity } from '../database/entities';

/** 配置行唯一键，用于消除 getOrCreate 的并发竞态 */
const CONFIG_KEY = 'default';

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code;
  const driver = (err as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || driver === '23505';
}

/**
 * 合约链路配置。
 *
 * 只承载**平台侧参数**（开关 / 交易对 / 运行模式 / 杠杆 / 保证金模式 /
 * 保证金占用比例）。策略参数、出场规则、风控阈值一概不在这里——
 * 那是策略自己的事，平台不干预（策略托管平台定位）。
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
      this.logger.log(`已初始化合约配置，运行模式=${mode}`);
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.repo.findOne({ where: { key: CONFIG_KEY } });
      if (existing) return existing;
      throw err;
    }
  }

  /** 读时归一化：兜住历史脏数据与直接改库绕过校验的情况 */
  toShape(entity: FuturesAgentConfigEntity): FuturesAgentConfigShape {
    return {
      enabled: entity.enabled,
      symbol: entity.symbol,
      mode: entity.mode,
      positionPct: Number(entity.positionPct),
      // 平台不做杠杆风控：只保证是 >=1 的整数（0/NaN 会导致下单必然失败）
      leverage: Math.max(1, Math.round(Number(entity.leverage) || 1)),
      marginType: entity.marginType === 'cross' ? 'cross' : 'isolated',
      lastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
    };
  }

  async get(): Promise<FuturesAgentConfigShape> {
    return this.toShape(await this.getOrCreate());
  }

  async update(patch: Partial<FuturesAgentConfigShape>): Promise<FuturesAgentConfigShape> {
    const row = await this.getOrCreate();
    const allowed: (keyof FuturesAgentConfigShape)[] = [
      'enabled',
      'symbol',
      'mode',
      'positionPct',
      'leverage',
      'marginType',
    ];

    for (const key of allowed) {
      const value = patch[key];
      if (value === undefined) continue;

      if (key === 'leverage') {
        const clamped = Math.max(1, Math.round(Number(value) || 1));
        if (clamped !== value) {
          this.logger.warn(`合约杠杆被规范化: ${String(value)} -> ${clamped}`);
        }
        row.leverage = clamped;
        continue;
      }

      if (key === 'positionPct') {
        row.positionPct = Math.min(1, Math.max(0.001, Number(value) || 0.001));
        continue;
      }

      if (key === 'marginType') {
        row.marginType = value === 'cross' ? 'cross' : 'isolated';
        continue;
      }

      (row as unknown as Record<string, unknown>)[key] = value;
    }

    if (patch.leverage !== undefined && patch.leverage !== row.leverage) {
      this.logger.warn(`合约杠杆变更: -> ${row.leverage}`);
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

  /** 推进最后运行时间（策略 tick 时调用，供总览展示「最近活动」） */
  async markRun(): Promise<void> {
    const row = await this.getOrCreate();
    row.lastRunAt = new Date();
    await this.repo.save(row);
  }

  /** 供调度器/运行器读取原始实体（含 lastRunAt 与开关） */
  async getEntity(): Promise<FuturesAgentConfigEntity> {
    return this.getOrCreate();
  }
}
