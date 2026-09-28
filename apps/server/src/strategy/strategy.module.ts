import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketModule } from '../market/market.module';
import { FuturesModule } from '../futures/futures.module';
import { AccountModule } from '../account/account.module';
import { BasketEntity, StrategyInstanceEntity } from '../database/entities';
import { MartingaleGridStrategy } from './martingale-grid.strategy';
import { TrendFollowingStrategy } from './trend-following.strategy';
import { StrategyRegistry } from './strategy-registry.service';
import { StrategyHub } from './strategy-hub.service';
import { StrategyInstanceService } from './strategy-instance.service';
import { StrategyExecutorService } from './strategy-executor.service';
import { StrategyRunner } from './strategy-runner.service';
import { PerformanceService } from './performance.service';
import { StrategyController } from './strategy.controller';

/**
 * 策略模块：策略运行器 + 注册表 + 执行器。
 *
 * 平台的能力（行情 / 下单 / 持仓 / 账户）从这里注入给策略；
 * 策略自治——何时开仓、加层、出场完全由策略决定，平台不做风控也不干预。
 */
@Module({
  imports: [
    MarketModule,
    FuturesModule,
    AccountModule,
    // 绩效服务按篮子聚合，需要篮子仓储；实例服务需要实例仓储
    TypeOrmModule.forFeature([BasketEntity, StrategyInstanceEntity]),
  ],
  providers: [
    MartingaleGridStrategy,
    TrendFollowingStrategy,
    StrategyRegistry,
    StrategyHub,
    StrategyInstanceService,
    StrategyExecutorService,
    StrategyRunner,
    PerformanceService,
  ],
  controllers: [StrategyController],
  exports: [StrategyRunner, StrategyRegistry, PerformanceService, StrategyHub],
})
export class StrategyModule {}
