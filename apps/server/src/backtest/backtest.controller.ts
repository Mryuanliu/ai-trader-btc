import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';
import type { BacktestRunKind, PageResult, BacktestRunSummary } from '@ai-trader/shared';
import type { CpcvOptions } from './research/cpcv';
import { BacktestService, type RunInput } from './backtest.service';

interface ResearchBody extends RunInput {
  trainBars?: number;
  testBars?: number;
  stepBars?: number;
  cpcv?: CpcvOptions;
}

interface SweepBody extends RunInput {
  paramGrid?: Record<string, number[]>;
}

/**
 * 回测台接口：单次回测 / 稳健性研究（walk-forward+CPCV+DSR）/ 参数扫描，及历史留存。
 *
 * 计算是同步的——几千根 5m 远小于 1 秒；跨度/网格规模在 service 侧有上限保护。
 * 每次成功运行都会落库一行，供「回测台 · 历史」回看与对比。
 */
@Controller('backtest')
@UseGuards(JwtAuthGuard)
export class BacktestController {
  constructor(private readonly service: BacktestService) {}

  @Post('run')
  async run(@Body() body: RunInput) {
    return this.guard(() => this.service.run(body));
  }

  @Post('research')
  async research(@Body() body: ResearchBody) {
    const { trainBars = 240, testBars = 120, stepBars, cpcv, ...input } = body;
    return this.guard(() =>
      this.service.research(input, { trainBars, testBars, stepBars, cpcv }),
    );
  }

  @Post('sweep')
  async sweep(@Body() body: SweepBody) {
    const { paramGrid, ...input } = body;
    if (!paramGrid || Object.keys(paramGrid).length === 0) {
      throw new BusinessException('BAD_REQUEST', '缺少 paramGrid');
    }
    return this.guard(() => this.service.sweep(input, paramGrid));
  }

  @Get('runs')
  runs(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('strategyName') strategyName?: string,
    @Query('kind') kind?: BacktestRunKind,
  ): Promise<PageResult<BacktestRunSummary>> {
    return this.service.listRuns({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      strategyName,
      kind,
    });
  }

  @Get('runs/:id')
  getRunById(@Param('id') id: string) {
    return this.guard(() => this.service.getRun(id));
  }

  @Delete('runs/:id')
  remove(@Param('id') id: string) {
    return this.service.deleteRun(id);
  }

  /** 把入参/数据校验类的同步 Error 归一为 400；其余（联网失败等）保持原样交给全局过滤器 */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? '回测失败';
      if (/缺少|非法|需要|过大|上限|不足|不存在|未知/.test(msg)) {
        throw new BusinessException('BAD_REQUEST', msg);
      }
      throw err;
    }
  }
}
