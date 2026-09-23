import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity, TradeFillEntity } from '../database/entities';
import { TradingService } from './trading.service';
import { OrdersController } from './orders.controller';
import { MarketModule } from '../market/market.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AccountModule } from '../account/account.module';

/**
 * 订单模块（跨市场共用表出口）。
 *
 * 平台只承担订单查询/同步/撤单与成交记账，**不做风控**（已移除 RiskService）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OrderEntity, TradeFillEntity]),
    MarketModule,
    ExchangesModule,
    AccountModule,
  ],
  providers: [TradingService],
  controllers: [OrdersController],
  exports: [TradingService],
})
export class TradingModule {}
