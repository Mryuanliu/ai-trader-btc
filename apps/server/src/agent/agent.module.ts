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
import { DecisionCoreService } from './decision-core.service';

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
  providers: [AgentEngine, LlmClient, StrategyService, DecisionCoreService],
  controllers: [AgentController],
  // 导出决策内核：合约引擎复用同一份 L0~L3 实现（现货与合约共用策略体系）
  exports: [AgentEngine, LlmClient, StrategyService, DecisionCoreService],
})
export class AgentModule {}
