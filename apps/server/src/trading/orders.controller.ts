import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  MarketType,
  OrderDTO,
  OrderSource,
  OrderStatus,
  PageResult,
} from '@ai-trader/shared';
import { TradingService } from './trading.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';
import { PositionService } from '../account/position.service';

const FUTURES_ONLY_ERROR =
  '本项目仅支持合约交易：手动下单请走 /api/futures/order（携带策略语义 action 与杠杆/保证金风控）';

/**
 * 订单查询接口（历史双市场共用表）。
 *
 * 仅合约模式下，市场维度锁定 futures——存量 market='spot' 的行保留在库内作审计，
 * 但不再对外展示，避免与合约口径混淆。
 * 手动下单走 `FuturesController` 的 POST /api/futures/order。
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly trading: TradingService,
    private readonly positions: PositionService,
  ) {}

  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: OrderStatus,
    @Query('symbol') symbol?: string,
    @Query('source') source?: OrderSource,
    @Query('market') market?: MarketType,
  ): Promise<PageResult<OrderDTO>> {
    // market 参数仅接受 futures（兼容旧前端传参），其余一律锁定合约
    return this.trading.list({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      status,
      symbol,
      source,
      market: 'futures',
    });
  }

  @Get('recent')
  async recent(@Query('limit') limit?: string): Promise<OrderDTO[]> {
    return this.trading.recent(Number(limit) || 10, 'futures');
  }

  /**
   * 回合盈亏：把「开仓→平仓」配对成逐笔明细（仅合约口径）。
   * 回合 netPnl 之和 === 合约持仓 realizedPnl。
   * 注意必须放在 @Get(':id/fills') 之前，否则 'round-trips' 会被当作 :id。
   */
  @Get('round-trips')
  async roundTrips(@Query('symbol') symbol?: string) {
    return this.positions.getRoundTrips(symbol || undefined);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async place(): Promise<OrderDTO> {
    throw new BusinessException('BAD_REQUEST', FUTURES_ONLY_ERROR);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/cancel')
  async cancel(@Param('id') id: string): Promise<OrderDTO> {
    return this.trading.cancelOrder(id);
  }

  @Get(':id/fills')
  async fills(@Param('id') id: string) {
    return this.trading.getFills(id);
  }
}
