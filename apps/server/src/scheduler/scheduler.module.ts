import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { TradingModule } from '../trading/trading.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { FuturesModule } from '../futures/futures.module';

/**
 * 调度模块（仅合约）。
 *
 * 主循环只负责：合约决策到期触发、未终结订单同步、新闻抓取、
 * 行情恢复与交易所连通性探测。现货 Agent 调度已随现货链路移除。
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MarketModule,
    NewsModule,
    TradingModule,
    ExchangesModule,
    FuturesModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
