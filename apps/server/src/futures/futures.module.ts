import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentDecisionEntity,
  FuturesAgentConfigEntity,
  OrderEntity,
  RiskEventEntity,
  TradeFillEntity,
} from '../database/entities';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesRiskService } from './futures-risk.service';
import { FuturesTradingService } from './futures-trading.service';
import { FuturesEngine } from './futures-engine.service';
import { FuturesDecisionsService } from './futures-decisions.service';
import { FuturesController } from './futures.controller';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AgentModule } from '../agent/agent.module';
import { NewsModule } from '../news/news.module';
import { AccountModule } from '../account/account.module';

/**
 * 合约模块（L4~L6 的合约实现 + 独立决策链路）。
 *
 * - L0~L3（指标/信号/策略/链路分派）通过 AgentModule 导出的 DecisionCoreService 复用
 * - L4~L6（执行/风控/持仓/下单）在这里独立实现
 * AccountModule 仅取 LotService 做仓位单记账（L5 持仓层共用数据模型）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FuturesAgentConfigEntity,
      OrderEntity,
      TradeFillEntity,
      RiskEventEntity,
      AgentDecisionEntity,
    ]),
    ExchangesModule,
    AgentModule,
    NewsModule,
    AccountModule,
  ],
  providers: [
    FuturesConfigService,
    FuturesPositionService,
    FuturesRiskService,
    FuturesTradingService,
    FuturesEngine,
    FuturesDecisionsService,
  ],
  controllers: [FuturesController],
  exports: [
    FuturesConfigService,
    FuturesPositionService,
    FuturesTradingService,
    FuturesEngine,
  ],
})
export class FuturesModule {}
