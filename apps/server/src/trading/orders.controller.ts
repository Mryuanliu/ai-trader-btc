import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  ExchangeCode,
  OrderDTO,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
  PageResult,
  PlaceOrderRequest,
} from '@ai-trader/shared';
import { TradingService } from './trading.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';
import { PositionService } from '../account/position.service';

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
  ): Promise<PageResult<OrderDTO>> {
    return this.trading.list({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      status,
      symbol,
      source,
    });
  }

  @Get('recent')
  async recent(@Query('limit') limit?: string): Promise<OrderDTO[]> {
    return this.trading.recent(Number(limit) || 10);
  }

  /**
   * 回合盈亏：把「开仓→平仓」配对成逐笔明细。
   * 现货/合约分别按各自持仓模型口径计算，回合 netPnl 之和 === 持仓面板 realizedPnl。
   * 注意必须放在 @Get(':id/fills') 之前，否则 'round-trips' 会被当作 :id。
   */
  @Get('round-trips')
  async roundTrips(
    @Query('market') market?: string,
    @Query('symbol') symbol?: string,
  ) {
    const m = market === 'futures' ? 'futures' : 'spot';
    return this.positions.getRoundTrips(m, symbol || undefined);
  }

  /** 手动下单：与 Agent 自动单走同一套风控 */
  @UseGuards(JwtAuthGuard)
  @Post()
  async place(@Body() body: PlaceOrderRequest): Promise<OrderDTO> {
    if (!body?.side || !body?.quantity) {
      throw new BusinessException('BAD_REQUEST', '缺少 side 或 quantity');
    }
    if (body.type === 'LIMIT' && !body.price) {
      throw new BusinessException('BAD_REQUEST', '限价单必须提供 price');
    }
    const result = await this.trading.placeOrder({
      exchange: body.exchange as ExchangeCode,
      symbol: body.symbol,
      side: body.side as OrderSide,
      type: (body.type ?? 'MARKET') as OrderType,
      quantity: Number(body.quantity),
      price: body.price ? Number(body.price) : undefined,
      source: 'manual',
      confirmToken: body.confirmToken,
    });
    return result.order;
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
