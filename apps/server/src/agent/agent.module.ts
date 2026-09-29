import { Module } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { LlmChatService } from './llm-chat.service';
import { SkillLoaderService } from './skill-loader.service';
import { McpToolSourceService } from './mcp-tool-source.service';
import { AiMarketService } from './ai-market.service';
import { AiMarketController } from './ai-market.controller';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';

/**
 * LLM 能力模块。
 *
 * 决策内核（指标信号 / 策略插件 / 链路分派）已随决策引擎移除；
 * 本模块提供：①「AI 行情分析」（AI 只解读市场，不参与交易决策）；
 * ②通用对话层 LlmChatService（多轮 + function-calling 工具循环，飞书机器人/Web 聊天复用）；
 * ③Agent Skills 加载器与 MCP 工具源（均为只加能力、不碰交易主链路）。
 */
@Module({
  imports: [MarketModule, NewsModule],
  providers: [LlmClient, LlmChatService, SkillLoaderService, McpToolSourceService, AiMarketService],
  controllers: [AiMarketController],
  exports: [LlmClient, LlmChatService, SkillLoaderService, McpToolSourceService, AiMarketService],
})
export class AgentModule {}
