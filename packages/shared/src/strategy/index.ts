export * from './types';
export * from './registry';
export * from './trend-following';
export * from './mean-reversion';
export * from './breakout';

import { strategyRegistry } from './registry';
import { TrendFollowingStrategy } from './trend-following';
import { MeanReversionStrategy } from './mean-reversion';
import { BreakoutStrategy } from './breakout';

// 内置策略注册：新增策略在补一行 register 即可，无需改动引擎
strategyRegistry.register(new TrendFollowingStrategy());
strategyRegistry.register(new MeanReversionStrategy());
strategyRegistry.register(new BreakoutStrategy());
