import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketCandleEntity } from '../database/entities';
import { CandleStoreService } from './candle-store.service';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [TypeOrmModule.forFeature([MarketCandleEntity]), ExchangesModule],
  providers: [CandleStoreService, MarketService],
  controllers: [MarketController],
  exports: [CandleStoreService, MarketService],
})
export class MarketModule {}
