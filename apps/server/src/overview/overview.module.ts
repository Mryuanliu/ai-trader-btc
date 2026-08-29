import { Module } from '@nestjs/common';
import { OverviewService } from './overview.service';
import { OverviewController } from './overview.controller';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { AgentModule } from '../agent/agent.module';
import { AgentConfigModule } from '../agent/agent-config.module';
import { AccountModule } from '../account/account.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [
    MarketModule,
    NewsModule,
    AgentModule,
    AgentConfigModule,
    AccountModule,
    TradingModule,
  ],
  providers: [OverviewService],
  controllers: [OverviewController],
  exports: [OverviewService],
})
export class OverviewModule {}
