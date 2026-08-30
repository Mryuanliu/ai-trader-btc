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
import { FuturesController } from './futures.controller';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AgentModule } from '../agent/agent.module';
import { NewsModule } from '../news/news.module';

/**
 * 合约模块（L4~L6 的合约实现 + 独立决策链路）。
 *
 * 与现货 TradingModule 平级且互不依赖：
 * - L0~L3（指标/信号/策略/链路分派）通过 AgentModule 导出的 DecisionCoreService 复用
 * - L4~L6（执行/风控/持仓）在这里独立实现
 * 关闭或删除本模块不影响现货链路，反之亦然。
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
  ],
  providers: [
    FuturesConfigService,
    FuturesPositionService,
    FuturesRiskService,
    FuturesTradingService,
    FuturesEngine,
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
