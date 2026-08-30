import { Module, OnModuleInit } from '@nestjs/common';
import { MarketExecutorRegistry } from './market-executor.registry';
import { SpotExecutor } from './spot-executor';
import { FuturesExecutor } from './futures-executor';
import { TradingModule } from '../trading/trading.module';
import { FuturesModule } from '../futures/futures.module';
import { MarketModule } from '../market/market.module';
import { AccountModule } from '../account/account.module';
import { AgentConfigModule } from '../agent/agent-config.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

/**
 * 执行器装配模块：启动时把现货与合约两个执行器注册进注册表。
 *
 * 新增市场时在此 register 一行即可，上层无需改动。
 */
@Module({
  imports: [
    TradingModule,
    FuturesModule,
    MarketModule,
    AccountModule,
    AgentConfigModule,
    ExchangesModule,
  ],
  providers: [MarketExecutorRegistry, SpotExecutor, FuturesExecutor],
  exports: [MarketExecutorRegistry],
})
export class ExecutionModule implements OnModuleInit {
  constructor(
    private readonly registry: MarketExecutorRegistry,
    private readonly spot: SpotExecutor,
    private readonly futures: FuturesExecutor,
  ) {}

  onModuleInit() {
    this.registry.register(this.spot);
    this.registry.register(this.futures);
  }
}
