import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TradingService } from './trading.service';
import { RiskService } from './risk.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('risk')
export class RiskController {
  constructor(
    private readonly risk: RiskService,
    private readonly trading: TradingService,
  ) {}

  /** 风控事件流水（含合约风控 FuturesRiskService 写入的事件） */
  @Get('events')
  async events(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.risk.list({ page: Number(page) || 1, pageSize: Number(pageSize) || 20 });
  }

  /** 当前回撤与今日合约订单情况 */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  async status() {
    const drawdown = await this.risk.currentDrawdownPct();
    const { filled, open } = await this.trading.statsToday();
    return {
      drawdownPct: Number(drawdown.toFixed(2)),
      filledToday: filled,
      openOrders: open,
    };
  }
}
