import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyModule } from '../strategy/strategy.module';
import { BacktestRunEntity } from '../database/entities/backtest-run.entity';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';

/**
 * 回测台模块（P0+）。
 *
 * 复用 parity 回放引擎（runBacktestOnCandles）+ research 闸门（walk-forward/CPCV/DSR/sweep），
 * 通过 REST 暴露给前端「回测台」，并把每次运行落库留历史。
 *
 * imports StrategyModule（forwardRef）：服务侧拿 Nest `StrategyRegistry` 做「未上架
 * 拒绝」白名单；未来 StrategyHub.setEnabled 反向依赖 BacktestService.hasPassingResearch 时
 * 不会形成循环。
 */
@Module({
  imports: [TypeOrmModule.forFeature([BacktestRunEntity]), forwardRef(() => StrategyModule)],
  controllers: [BacktestController],
  providers: [BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
