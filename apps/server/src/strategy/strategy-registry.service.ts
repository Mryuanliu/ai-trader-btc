import { Injectable } from '@nestjs/common';
import { MartingaleGridStrategy } from './martingale-grid.strategy';
import type { StrategyDescriptor, TradingStrategy } from './types';

/**
 * 策略注册表。
 *
 * 平台是「策略合集」：新增策略只需实现 TradingStrategy 并在构造函数注册一行。
 * 运行器只认注册表里的策略，不允许按名字动态加载任意模块。
 */
@Injectable()
export class StrategyRegistry {
  private readonly strategies = new Map<string, TradingStrategy>();

  constructor(martingaleGrid: MartingaleGridStrategy) {
    this.register(martingaleGrid);
  }

  register(strategy: TradingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): TradingStrategy | undefined {
    return this.strategies.get(name);
  }

  require(name: string): TradingStrategy {
    const s = this.strategies.get(name);
    if (!s) throw new Error(`未知策略：${name}`);
    return s;
  }

  /** 策略卡片页用的列表 */
  list(): StrategyDescriptor[] {
    return [...this.strategies.values()].map((s) => ({
      name: s.name,
      label: s.label,
      description: s.description,
      defaultParams: s.defaultParams,
      paramSchema: s.paramSchema,
    }));
  }
}
