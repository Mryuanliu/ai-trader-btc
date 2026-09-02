import { Module } from '@nestjs/common';
import { OverviewService } from './overview.service';
import { OverviewController } from './overview.controller';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { AccountModule } from '../account/account.module';
import { TradingModule } from '../trading/trading.module';
import { FuturesModule } from '../futures/futures.module';
import { AgentModule } from '../agent/agent.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [
    MarketModule,
    NewsModule,
    AccountModule,
    TradingModule,
    // 合约总览数据源：FuturesConfig/FuturesEngine/FuturesTrading/FuturesPosition
    FuturesModule,
    // LlmClient（判断 llmAvailable）
    AgentModule,
    // ExchangeRegistry（读合约钱包余额）
    ExchangesModule,
  ],
  providers: [OverviewService],
  controllers: [OverviewController],
  exports: [OverviewService],
})
export class OverviewModule {}
