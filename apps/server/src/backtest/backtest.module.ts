import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundingRateEntity, MarketCandleEntity } from '../database/entities';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  imports: [TypeOrmModule.forFeature([MarketCandleEntity, FundingRateEntity])],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
