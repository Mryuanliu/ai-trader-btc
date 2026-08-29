import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { AgentEngine } from './agent-engine.service';
import { LlmClient } from './llm.client';
import { AgentConfigModule } from './agent-config.module';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { AccountModule } from '../account/account.module';
import { TradingModule } from '../trading/trading.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AgentController } from './agent.controller';
import { StrategyService } from './strategy.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentDecisionEntity]),
    AgentConfigModule,
    MarketModule,
    NewsModule,
    AccountModule,
    TradingModule,
    ExchangesModule,
  ],
  providers: [AgentEngine, LlmClient, StrategyService],
  controllers: [AgentController],
  exports: [AgentEngine, LlmClient, StrategyService],
})
export class AgentModule {}
