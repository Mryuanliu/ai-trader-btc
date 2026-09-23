import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { OrderDTO, OrderSource, OrderStatus, PageResult } from '@ai-trader/shared';
import { TradingService } from './trading.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * 订单查询接口（平台的「监控订单」能力）。
 *
 * 只保留分页列表——移动端首页拿它展示最近成交。
 * 其余路由（recent / round-trips / fills / cancel / place）已随对应前端页面与
 * 决策引擎移除：手动下单走 `POST /api/futures/order`，合约订单列表走
 * `GET /api/futures/orders`。
 *
 * 仅合约：存量 market='spot' 的行保留在库内作审计，但不再对外展示。
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly trading: TradingService) {}

  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: OrderStatus,
    @Query('symbol') symbol?: string,
    @Query('source') source?: OrderSource,
  ): Promise<PageResult<OrderDTO>> {
    return this.trading.list({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      status,
      symbol,
      source,
      market: 'futures',
    });
  }
}
