import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { FuturesModule } from '../futures/futures.module';
import { StrategyModule } from '../strategy/strategy.module';

/**
 * 调度模块。
 *
 * 主循环只负责：喂行情、抓新闻、合约成交对账、触发 dry-run 挂单，
 * 以及**驱动已挂载的策略**（通过 StrategyModule 导出的 StrategyRunner）。
 * 平台不再有决策调度——何时交易由策略自己决定。
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MarketModule,
    NewsModule,
    ExchangesModule,
    FuturesModule,
    // StrategyRunner：主循环每 5 秒驱动一次策略 tick
    StrategyModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
