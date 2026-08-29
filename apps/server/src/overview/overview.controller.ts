import { Controller, Get, Query } from '@nestjs/common';
import { DEFAULT_SYMBOL, OverviewDTO } from '@ai-trader/shared';
import { OverviewService } from './overview.service';

@Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  /** 移动端钱包首页与 PC 后台总览共用的聚合接口 */
  @Get()
  async get(@Query('symbol') symbol = DEFAULT_SYMBOL): Promise<OverviewDTO> {
    return this.overview.build(symbol);
  }
}
