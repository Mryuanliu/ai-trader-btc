import { Module } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { AiMarketService } from './ai-market.service';
import { AiMarketController } from './ai-market.controller';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';

/**
 * LLM 能力模块。
 *
 * 决策内核（指标信号 / 策略插件 / 链路分派）已随决策引擎移除；
 * 本模块现在只提供「AI 行情分析」——AI 只解读市场，不参与交易决策，
 * 输出不进入任何下单路径。
 */
@Module({
  imports: [MarketModule, NewsModule],
  providers: [LlmClient, AiMarketService],
  controllers: [AiMarketController],
  exports: [LlmClient, AiMarketService],
})
export class AgentModule {}
