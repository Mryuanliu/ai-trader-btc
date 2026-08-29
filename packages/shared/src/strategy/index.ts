export * from './types';
export * from './registry';
export * from './trend-following';

import { strategyRegistry } from './registry';
import { TrendFollowingStrategy } from './trend-following';

// 内置策略注册：新增策略在补一行 register 即可，无需改动引擎
strategyRegistry.register(new TrendFollowingStrategy());
