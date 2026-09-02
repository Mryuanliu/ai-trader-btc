import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OrderEntity,
  PositionLotEntity,
  TradeFillEntity,
} from '../database/entities';
import { PositionService } from './position.service';
import { LotService } from './lot.service';
import { LotsController } from './lots.controller';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { MarketModule } from '../market/market.module';

/**
 * 账户模块（合约口径）。
 *
 * 仅合约模式下只剩两个职责：
 * - `PositionService` —— 由 trade_fills 推导合约回合盈亏（展示口径）
 * - `LotService`      —— 订单级仓位单（Lot）记账，现货/合约共用
 *
 * 原 `AccountService`（现货余额/虚拟账户/快照）已随现货链路移除；
 * 合约余额以交易所 fapi account 为权威（FuturesTradingService）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OrderEntity, TradeFillEntity, PositionLotEntity]),
    ExchangesModule,
    MarketModule,
  ],
  providers: [PositionService, LotService],
  controllers: [LotsController],
  exports: [PositionService, LotService],
})
export class AccountModule {}
