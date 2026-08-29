import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentConfigShape,
  DEFAULT_AGENT_CONFIG,
  ExchangeCode,
  RunMode,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentConfigEntity } from '../database/entities';

@Injectable()
export class AgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);

  constructor(
    @InjectRepository(AgentConfigEntity)
    private readonly repo: Repository<AgentConfigEntity>,
    private readonly config: ConfigService,
  ) {}

  async getOrCreate(): Promise<AgentConfigEntity> {
    let row = await this.repo.findOne({ where: {}, order: { createdAt: 'ASC' } });
    if (!row) {
      const mode = (this.config.get<string>('APP_RUN_MODE', 'dry_run') || 'dry_run') as RunMode;
      row = await this.repo.save(
        this.repo.create({
          ...DEFAULT_AGENT_CONFIG,
          mode,
        }),
      );
      this.logger.log(`已初始化 Agent 配置，运行模式=${mode}`);
    }
    return row;
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
      maxOrderAmount: entity.maxOrderAmount,
      maxDailyOrders: entity.maxDailyOrders,
      maxDrawdownPct: entity.maxDrawdownPct,
      minOrderIntervalSec: entity.minOrderIntervalSec,
      dailyLossLimit: entity.dailyLossLimit,
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
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        (row as unknown as Record<string, unknown>)[key] = patch[key];
      }
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
