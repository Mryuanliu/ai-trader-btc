import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { strategyRegistry } from '@ai-trader/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BacktestService, BacktestRequestDto } from './backtest.service';

@Controller('backtest')
@UseGuards(JwtAuthGuard)
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  /** 策略清单与参数 schema（前端动态表单/回测表单共用） */
  @Get('strategies')
  listStrategies() {
    return strategyRegistry.list().map((s) => ({
      name: s.name,
      label: s.label,
      description: s.description,
      defaultParams: s.defaultParams,
      paramSchema: s.paramSchema,
    }));
  }

  /** 同步执行一次回测并返回完整报告 */
  @Post('run')
  run(@Body() dto: BacktestRequestDto) {
    return this.backtest.run(dto);
  }

  /** 当前回测执行进度（轮询用；空闲返回 null） */
  @Get('progress')
  progress() {
    return this.backtest.getProgress();
  }
}
