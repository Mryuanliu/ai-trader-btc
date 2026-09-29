import type { StrategyRegistry as NestStrategyRegistry } from '../strategy/strategy-registry.service';
import type { TradingStrategy } from '../strategy/types';
import { TrendFollowingStrategy } from '../strategy/trend-following.strategy';
import { MartingaleGridStrategy } from '../strategy/martingale-grid.strategy';
import { DonchianBreakoutStrategy } from '../strategy/donchian-breakout.strategy';

/**
 * 回测可装配的策略工厂（**单一来源**）。
 *
 * CLI、BacktestService、research（walk-forward/sweep）都从这里取，避免多处各写一份注册。
 * 每次 `createStrategy` 都 `new` 一个**全新实例**——回测/研究要求每段独立、无跨段状态残留，
 * 且必须可确定性地重复。
 *
 * 服务侧（HTTP `POST /backtest/run` 等）用 `createStrategyFresh(name, nestRegistry)`：
 * 通过 Nest 侧 StrategyRegistry 校验「策略是否已上架」，未上架直接拒绝，避免回测端
 * 跑到 hub 之外的野名字。CLI 无 Nest 上下文，保留 `createStrategy(name)` 走内置 map。
 */
export const STRATEGY_REGISTRY: Record<string, () => TradingStrategy> = {
  trend_following: () => new TrendFollowingStrategy(),
  martingale_grid: () => new MartingaleGridStrategy(),
  donchian_breakout: () => new DonchianBreakoutStrategy(),
};

export function createStrategy(name: string): TradingStrategy {
  const factory = STRATEGY_REGISTRY[name];
  if (!factory) {
    throw new Error(`未知策略：${name}（可选：${Object.keys(STRATEGY_REGISTRY).join(', ')}）`);
  }
  return factory();
}

/**
 * 服务侧工厂：先经 Nest StrategyRegistry 白名单校验（未上架 → 抛「策略未上架」），
 * 通过后仍从内置 map `new` 一个 fresh 实例（回测要求无状态残留）。
 * 未内置实现但 hub 已上架的策略：目前不支持动态实例化（留给 P4 市场运营）。
 */
export function createStrategyFresh(
  name: string,
  registry?: Pick<NestStrategyRegistry, 'get'>,
): TradingStrategy {
  if (registry && !registry.get(name)) {
    throw new Error(`策略未上架：${name}`);
  }
  return createStrategy(name);
}

export function availableStrategies(): string[] {
  return Object.keys(STRATEGY_REGISTRY);
}
