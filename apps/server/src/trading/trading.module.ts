import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BalanceSnapshotEntity,
  OrderEntity,
  RiskEventEntity,
  TradeFillEntity,
} from '../database/entities';
import { TradingService } from './trading.service';
import { RiskService } from './risk.service';
import { OrdersController } from './orders.controller';
import { RiskController } from './risk.controller';
import { AgentConfigModule } from '../agent/agent-config.module';
import { MarketModule } from '../market/market.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      TradeFillEntity,
      RiskEventEntity,
      BalanceSnapshotEntity,
    ]),
    AgentConfigModule,
    MarketModule,
    ExchangesModule,
    AccountModule,
  ],
  providers: [TradingService, RiskService],
  controllers: [OrdersController, RiskController],
  exports: [TradingService, RiskService],
})
export class TradingModule {}
