import { Injectable, Logger } from '@nestjs/common';
import { StrategyContext, StrategyOutput, strategyRegistry } from '@ai-trader/shared';

/**
 * 策略执行服务：按 name 从注册表取策略并执行。
 * 引擎与回测都经由本服务调用策略，name 无效时回退 trend_following 并留下告警，
 * fellBack 由调用方写入决策记录的 degradeReason，保证配置错误可见而非静默。
 */
@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  evaluate(
    name: string,
    base: Omit<StrategyContext, 'params'>,
    rawParams?: Record<string, unknown> | null,
  ): { output: StrategyOutput; strategyName: string; fellBack: boolean } {
    const { strategy, fellBack } = strategyRegistry.getOrDefault(name);
    if (fellBack) {
      this.logger.warn(`策略 ${name} 不存在，已回退 ${strategy.name}`);
    }
    const params = strategy.normalizeParams(rawParams);
    return { output: strategy.evaluate({ ...base, params }), strategyName: strategy.name, fellBack };
  }
}
