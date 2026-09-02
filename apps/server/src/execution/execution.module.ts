import { Module, OnModuleInit } from '@nestjs/common';
import { MarketExecutorRegistry } from './market-executor.registry';
import { FuturesExecutor } from './futures-executor';
import { FuturesModule } from '../futures/futures.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

/**
 * 执行器装配模块：启动时把合约执行器注册进注册表。
 *
 * 仅合约模式下只有 FuturesExecutor。新增市场时在此 register 一行即可，上层无需改动。
 */
@Module({
  imports: [FuturesModule, ExchangesModule],
  providers: [MarketExecutorRegistry, FuturesExecutor],
  exports: [MarketExecutorRegistry],
})
export class ExecutionModule implements OnModuleInit {
  constructor(
    private readonly registry: MarketExecutorRegistry,
    private readonly futures: FuturesExecutor,
  ) {}

  onModuleInit() {
    this.registry.register(this.futures);
  }
}
