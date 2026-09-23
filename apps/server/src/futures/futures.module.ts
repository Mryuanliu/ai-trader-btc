import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FuturesAgentConfigEntity, OrderEntity, TradeFillEntity } from '../database/entities';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesTradingService } from './futures-trading.service';
import { FuturesController } from './futures.controller';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { NewsModule } from '../news/news.module';
import { AccountModule } from '../account/account.module';

/**
 * 合约模块：**只管执行，不管决策**。
 *
 * 这里提供平台的下单/持仓/账户能力，供策略运行器（StrategyModule）与手动交易调用。
 * 决策引擎、风控服务、决策记录已移除——何时开仓、何时平仓、风险多大，
 * 全部由挂载的策略自行决定；平台只保证「指令正确送达交易所」。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FuturesAgentConfigEntity, OrderEntity, TradeFillEntity]),
    ExchangesModule,
    NewsModule,
    AccountModule,
  ],
  providers: [FuturesConfigService, FuturesPositionService, FuturesTradingService],
  controllers: [FuturesController],
  exports: [FuturesConfigService, FuturesPositionService, FuturesTradingService],
})
export class FuturesModule {}
