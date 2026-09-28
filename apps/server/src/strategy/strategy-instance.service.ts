import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyInstanceEntity } from '../database/entities/strategy-instance.entity';

/**
 * 策略运行实例服务（P2 多实例）。
 *
 * `strategy_instances` 表是**多实例运行意图的唯一事实来源**：
 * - 启动实例 → upsert 一行（shouldRun=true）
 * - 停止实例 → shouldRun=false
 * - 服务重启 → 读所有 shouldRun=true 的行，逐个恢复挂载
 *
 * instanceId = `策略名:交易对`（如 `martingale_grid:BTCUSDT`），
 * 同策略可跑不同交易对，同交易对也可跑不同策略。
 */
@Injectable()
export class StrategyInstanceService {
  private readonly logger = new Logger(StrategyInstanceService.name);

  constructor(
    @InjectRepository(StrategyInstanceEntity)
    private readonly repo: Repository<StrategyInstanceEntity>,
  ) {}

  /** 实例标识（策略名 + 交易对） */
  static instanceIdOf(strategyName: string, symbol: string): string {
    return `${strategyName}:${symbol}`;
  }

  /** 启动/更新实例的运行意图（upsert，天然幂等） */
  async markRunning(input: {
    strategyName: string;
    symbol: string;
    params: Record<string, unknown> | null;
  }): Promise<StrategyInstanceEntity> {
    const instanceId = StrategyInstanceService.instanceIdOf(input.strategyName, input.symbol);
    let row = await this.repo.findOne({ where: { instanceId } });
    if (!row) {
      row = this.repo.create({
        instanceId,
        strategyName: input.strategyName,
        symbol: input.symbol,
      });
    }
    row.params = input.params;
    row.shouldRun = true;
    row.startedAt = new Date();
    return this.repo.save(row);
  }

  /** 停止实例（保留记录便于追溯，只清运行意图） */
  async markStopped(instanceId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { instanceId } });
    if (!row) return;
    row.shouldRun = false;
    await this.repo.save(row);
  }

  /** 重启恢复用：所有标记为应运行的实例 */
  async listShouldRun(): Promise<StrategyInstanceEntity[]> {
    return this.repo.find({ where: { shouldRun: true } });
  }

  /** 全部实例（含已停止的，供前端展示） */
  async listAll(): Promise<StrategyInstanceEntity[]> {
    return this.repo.find({ order: { updatedAt: 'DESC' } });
  }
}
