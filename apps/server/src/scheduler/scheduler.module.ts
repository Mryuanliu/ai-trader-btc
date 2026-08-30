import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { AgentModule } from '../agent/agent.module';
import { AgentConfigModule } from '../agent/agent-config.module';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { AccountModule } from '../account/account.module';
import { TradingModule } from '../trading/trading.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { FuturesModule } from '../futures/futures.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AgentModule,
    AgentConfigModule,
    MarketModule,
    NewsModule,
    AccountModule,
    TradingModule,
    ExchangesModule,
    FuturesModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
