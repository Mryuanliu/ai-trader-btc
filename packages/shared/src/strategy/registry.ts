import type { Strategy } from './types';

export interface StrategyLookup {
  strategy: Strategy;
  /** 请求的 name 不存在，已回退到 trend_following */
  fellBack: boolean;
  requestedName: string;
}

/**
 * 策略注册表。策略是插件式集合：新增一个策略只需实现 Strategy 接口并注册，
 * 引擎与回测不感知具体策略。
 */
export class StrategyRegistry {
  private readonly strategies = new Map<string, Strategy>();

  register(strategy: Strategy): void {
    if (this.strategies.has(strategy.name)) {
      // 后注册覆盖先注册，但留 warn 避免静默吞掉命名冲突
      console.warn(`[StrategyRegistry] 策略 ${strategy.name} 已存在，将被覆盖`);
    }
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): Strategy | null {
    return this.strategies.get(name) ?? null;
  }

  /**
   * 取策略；name 无效时回退 trend_following（保证注册表非空的前提），
   * 并携带 fellBack 标记让调用方把配置错误写入决策记录，而非静默吞掉。
   */
  getOrDefault(name: string): StrategyLookup {
    const found = this.strategies.get(name);
    if (found) return { strategy: found, fellBack: false, requestedName: name };
    const fallback = this.strategies.get('trend_following');
    if (!fallback) {
      throw new Error('StrategyRegistry 未注册 trend_following，请检查 strategy/index.ts');
    }
    return { strategy: fallback, fellBack: true, requestedName: name };
  }

  list(): {
    name: string;
    label: string;
    description: string;
    defaultParams: Record<string, unknown>;
    paramSchema: Record<string, unknown> | null;
  }[] {
    return [...this.strategies.values()].map((s) => ({
      name: s.name,
      label: s.label,
      description: s.description,
      defaultParams: s.defaultParams,
      paramSchema: s.paramSchema ?? null,
    }));
  }
}

/** 全局单例，strategy/index.ts 中完成内置策略注册 */
export const strategyRegistry = new StrategyRegistry();
