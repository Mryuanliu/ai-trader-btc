import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceSnapshotEntity, OrderEntity, TradeFillEntity } from '../database/entities';
import { AccountService } from './account.service';
import { PositionService } from './position.service';
import { MarketModule } from '../market/market.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BalanceSnapshotEntity, OrderEntity, TradeFillEntity]),
    MarketModule,
    ExchangesModule,
  ],
  providers: [AccountService, PositionService],
  exports: [AccountService, PositionService],
})
export class AccountModule {}
