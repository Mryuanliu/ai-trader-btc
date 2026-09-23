import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { FuturesModule } from '../futures/futures.module';
import { AccountModule } from '../account/account.module';
import { MartingaleGridStrategy } from './martingale-grid.strategy';
import { StrategyRegistry } from './strategy-registry.service';
import { StrategyExecutorService } from './strategy-executor.service';
import { StrategyRunner } from './strategy-runner.service';
import { StrategyController } from './strategy.controller';

/**
 * 策略模块：策略运行器 + 注册表 + 执行器。
 *
 * 平台的能力（行情 / 下单 / 持仓 / 账户）从这里注入给策略；
 * 策略自治——何时开仓、加层、出场完全由策略决定，平台不做风控也不干预。
 */
@Module({
  imports: [MarketModule, FuturesModule, AccountModule],
  providers: [
    MartingaleGridStrategy,
    StrategyRegistry,
    StrategyExecutorService,
    StrategyRunner,
  ],
  controllers: [StrategyController],
  exports: [StrategyRunner, StrategyRegistry],
})
export class StrategyModule {}
