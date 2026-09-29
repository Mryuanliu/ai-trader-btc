import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeishuService } from './feishu.service';
import { FeishuNotificationService } from './feishu-notification.service';
import { FeishuBotService } from './feishu-bot.service';
import { FeishuAgentService } from './feishu-agent.service';
import { ConfirmationStore } from './confirmation.store';
import { TradingToolsService } from './tools/trading-tools.service';
import { FeishuMessageReceiptEntity } from './entities/feishu-message-receipt.entity';
import { FeishuChatSessionEntity } from './entities/feishu-chat-session.entity';
import { AgentModule } from '../agent/agent.module';
import { AccountModule } from '../account/account.module';
import { OverviewModule } from '../overview/overview.module';
import { FuturesModule } from '../futures/futures.module';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { StrategyModule } from '../strategy/strategy.module';

/**
 * 飞书模块：推送（成交/结束卡片）+ 对话机器人（长连接 + LLM 工具循环）。
 *
 * EventBusService（CommonModule @Global）与 ConfigService（ConfigModule isGlobal）
 * 均为全局提供，无需显式 import。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FeishuMessageReceiptEntity, FeishuChatSessionEntity]),
    AgentModule,
    AccountModule,
    OverviewModule,
    FuturesModule,
    MarketModule,
    NewsModule,
    StrategyModule,
  ],
  providers: [
    FeishuService,
    FeishuNotificationService,
    FeishuBotService,
    FeishuAgentService,
    ConfirmationStore,
    TradingToolsService,
  ],
  exports: [FeishuService],
})
export class FeishuModule {}
