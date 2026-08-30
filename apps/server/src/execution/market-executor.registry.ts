import { Injectable, Logger } from '@nestjs/common';
import { MarketExecutor, MarketType, MARKETS } from '@ai-trader/shared';

/**
 * 市场执行器注册表：可插拔的落点。
 *
 * 上层（决策引擎、调度器）只依赖 MarketExecutor 接口，通过本注册表按市场取实现，
 * 因此新增市场（如期权）只需实现接口并注册，不改动任何调度与决策代码。
 */
@Injectable()
export class MarketExecutorRegistry {
  private readonly logger = new Logger(MarketExecutorRegistry.name);
  private readonly map = new Map<MarketType, MarketExecutor>();

  register(executor: MarketExecutor): void {
    if (this.map.has(executor.market)) {
      this.logger.warn(`市场执行器 ${executor.market} 被重复注册，已覆盖`);
    }
    this.map.set(executor.market, executor);
    this.logger.log(
      `已注册市场执行器：${executor.market} -> ${executor.exchange}`,
    );
  }

  /** 取指定市场的执行器，未注册时抛错（早失败优于静默返回错误实现） */
  get(market: MarketType): MarketExecutor {
    const executor = this.map.get(market);
    if (!executor) {
      throw new Error(`未注册的市场执行器: ${market}`);
    }
    return executor;
  }

  /** 是否已注册该市场 */
  has(market: MarketType): boolean {
    return this.map.has(market);
  }

  /** 已注册的全部市场 */
  list(): MarketType[] {
    return MARKETS.filter((m) => this.map.has(m));
  }
}
