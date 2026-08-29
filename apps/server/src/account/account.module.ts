import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceSnapshotEntity, OrderEntity } from '../database/entities';
import { AccountService } from './account.service';
import { MarketModule } from '../market/market.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BalanceSnapshotEntity, OrderEntity]),
    MarketModule,
    ExchangesModule,
  ],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
