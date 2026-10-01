import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_FUTURES_AGENT_CONFIG, DEFAULT_PROTECTIONS, FuturesAgentConfigShape, ProtectionsConfig, RunMode } from '@ai-trader/shared';
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
 * 保证金占用比例）。策略参数、出场规则一概不在这里——那是策略自己的事，
 * 平台不干预（策略托管平台定位）。唯一例外是 `protections`（D4 平台侧熔断兜底）：
 * 它不介入下单/仓位/出场，只在命中判据时停实例，属平台生命周期守卫而非策略风控。
 */
/** 归一化熔断配置：非法/缺失字段逐项回落默认；夹取到合理区间，保证策略永不因脏配置崩溃 */
function normalizeProtections(raw?: Partial<ProtectionsConfig> | null): ProtectionsConfig {
  const src = raw ?? {};
  const numOr = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
  const intOr = (v: unknown, d: number): number => Math.floor(numOr(v, d));
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_PROTECTIONS.enabled,
    // 连亏笔数：至少 1（0 会「一亏就停」，不符合兜底定位）
    maxConsecutiveLosses: Math.max(1, intOr(src.maxConsecutiveLosses, DEFAULT_PROTECTIONS.maxConsecutiveLosses)),
    // 回撤百分比：(0, 100]
    maxDrawdownPct: Math.min(100, Math.max(0.1, numOr(src.maxDrawdownPct, DEFAULT_PROTECTIONS.maxDrawdownPct))),
    capitalBaseUsdt: Math.max(1, numOr(src.capitalBaseUsdt, DEFAULT_PROTECTIONS.capitalBaseUsdt)),
    // 窗口：≥0（0=全部）
    lookbackBaskets: Math.max(0, intOr(src.lookbackBaskets, DEFAULT_PROTECTIONS.lookbackBaskets)),
  };
}

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
      protections: normalizeProtections(entity.protections),
      lastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
    };
  }

  async get(): Promise<FuturesAgentConfigShape> {
    return this.toShape(await this.getOrCreate());
  }

  /**
   * 读写「策略运行意图」（自动恢复用）。
   *
   * 只由 StrategyRunner 在 start/stop 时调用：
   * 启动成功写入意图，停止/失败清除——保证重启后恢复的是
   * 「用户真正想要的运行状态」而不是某个中间态。
   */
  async patchRunningIntent(input: {
    shouldRun: boolean;
    name: string | null;
    params: Record<string, unknown> | null;
  }): Promise<void> {
    const row = await this.getOrCreate();
    row.strategyShouldRun = input.shouldRun;
    row.strategyRunName = input.name;
    row.strategyRunParams = input.params;
    await this.repo.save(row);
  }

  /** 读运行意图（服务启动时用） */
  async getRunningIntent(): Promise<{
    shouldRun: boolean;
    name: string | null;
    params: Record<string, unknown> | null;
  }> {
    const row = await this.getOrCreate();
    return {
      shouldRun: row.strategyShouldRun,
      name: row.strategyRunName,
      params: row.strategyRunParams,
    };
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
      'protections',
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

      if (key === 'protections') {
        row.protections = normalizeProtections(value as Partial<ProtectionsConfig>);
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
