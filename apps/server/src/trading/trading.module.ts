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
import { MarketModule } from '../market/market.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AccountModule } from '../account/account.module';

/**
 * 订单/风控事件模块（跨市场共用表出口）。
 *
 * 仅合约模式下本模块只承担订单查询/同步/撤单与风控事件流水；
 * 合约下单走 `FuturesModule` 的 FuturesTradingService。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      TradeFillEntity,
      RiskEventEntity,
      BalanceSnapshotEntity,
    ]),
    MarketModule,
    ExchangesModule,
    AccountModule,
  ],
  providers: [TradingService, RiskService],
  controllers: [OrdersController, RiskController],
  exports: [TradingService, RiskService],
})
export class TradingModule {}
