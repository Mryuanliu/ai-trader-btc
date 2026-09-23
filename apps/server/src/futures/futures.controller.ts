import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { FuturesAgentConfigShape, FuturesPositionView } from '@ai-trader/shared';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesTradingService, PlaceFuturesOrderResult } from './futures-trading.service';
import { LotService } from '../account/lot.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';

/**
 * 合约接口：配置、持仓、保证金、手动下单。
 *
 * 决策相关路由（/run、/health、/decisions*）已随决策引擎移除。
 * 策略的启停与状态在 `/strategy` 下（StrategyController）。
 */
@Controller('futures')
export class FuturesController {
  constructor(
    private readonly config: FuturesConfigService,
    private readonly positions: FuturesPositionService,
    private readonly trading: FuturesTradingService,
    private readonly lots: LotService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('config')
  async getConfig(): Promise<FuturesAgentConfigShape> {
    return this.config.get();
  }

  @UseGuards(JwtAuthGuard)
  @Patch('config')
  async updateConfig(
    @Body() patch: Partial<FuturesAgentConfigShape>,
  ): Promise<FuturesAgentConfigShape> {
    return this.config.update(patch);
  }

  /** 合约持仓：以交易所 positionRisk 为权威 */
  @UseGuards(JwtAuthGuard)
  @Get('positions')
  async listPositions(@Query('symbol') symbol = 'BTCUSDT'): Promise<FuturesPositionView[]> {
    const rows = await this.positions.listPositions(symbol);
    return rows
      .filter((r) => Math.abs(r.quantity) > 0)
      .map((r) => ({
        symbol: r.symbol,
        market: 'futures' as const,
        quantity: r.quantity,
        positionSide: r.quantity > 0 ? ('LONG' as const) : ('SHORT' as const),
        entryPrice: r.entryPrice,
        markPrice: r.markPrice,
        liquidationPrice: r.liquidationPrice,
        leverage: r.leverage,
        marginType: r.marginType,
        isolatedMargin: r.isolatedMargin,
        unrealizedPnl: r.unrealizedPnl,
        notional: r.notional,
        liquidationDistancePct: r.liquidationDistancePct,
      }));
  }

  /** 合约账户可用保证金 */
  @UseGuards(JwtAuthGuard)
  @Get('margin')
  async margin(): Promise<{ available: number }> {
    return { available: await this.trading.getAvailableMargin() };
  }

  /**
   * 手动执行合约动作。
   * 传入的是策略语义的 BUY/SELL（不是「开多/开空」），
   * 由执行器结合当前持仓翻译成开/加/平，避免调用方重复实现方向判断。
   */
  @UseGuards(JwtAuthGuard)
  @Post('order')
  async placeOrder(
    @Body()
    body: {
      action?: string;
      symbol?: string;
      type?: 'MARKET' | 'LIMIT';
      price?: number;
      quantity?: number;
      leverage?: number;
      /**
       * 手动平仓目标仓位单（Lot）：传了表示「全量平掉该 Lot」。
       * 不传表示开仓（BUY 开多 / SELL 开空）。
       */
      lotId?: string;
    },
  ): Promise<PlaceFuturesOrderResult> {
    const action = body?.action;
    if (action !== 'BUY' && action !== 'SELL' && action !== 'HOLD') {
      throw new BusinessException('BAD_REQUEST', 'action 必须是 BUY / SELL / HOLD');
    }
    // 手动平仓必须带 lotId（每笔 Lot 全量平掉才算完结，避免碎单）
    if (body.lotId) {
      if (action === 'HOLD') {
        throw new BusinessException('BAD_REQUEST', '平仓 Lot 时 action 不能为 HOLD');
      }
      const lot = await this.lots.getOpenLot(body.lotId);
      if (!lot) {
        throw new BusinessException('BAD_REQUEST', '未找到未完结的仓位单（lotId 无效或已平仓）');
      }
      // 校验方向：平 LONG 仓必须 SELL，平 SHORT 仓必须 BUY
      const required = lot.direction === 'LONG' ? 'SELL' : 'BUY';
      if (action !== required) {
        throw new BusinessException(
          'BAD_REQUEST',
          `平 ${lot.direction} 仓必须用 ${required}（当前 action=${action}）`,
        );
      }
    }
    return this.trading.placeOrder({
      symbol: body.symbol,
      action,
      type: body.type ?? 'MARKET',
      price: body.price,
      quantity: body.quantity,
      leverage: body.leverage,
      lotId: body.lotId,
      exitReason: body.lotId ? 'MANUAL' : undefined,
      source: 'manual',
    });
  }

  /** 合约订单（含挂单）列表，供平台侧的订单监控 */
  @UseGuards(JwtAuthGuard)
  @Get('orders')
  async listOrders(@Query('limit') limit?: string) {
    return this.trading.list({ limit: Number(limit) || 20 });
  }
}
