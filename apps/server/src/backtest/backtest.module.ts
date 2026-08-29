import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketCandleEntity } from '../database/entities';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  imports: [TypeOrmModule.forFeature([MarketCandleEntity])],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
