import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { FuturesAgentConfigShape, FuturesPositionView } from '@ai-trader/shared';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesTradingService, PlaceFuturesOrderResult } from './futures-trading.service';
import { FuturesEngine } from './futures-engine.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';

@Controller('futures')
export class FuturesController {
  constructor(
    private readonly config: FuturesConfigService,
    private readonly positions: FuturesPositionService,
    private readonly trading: FuturesTradingService,
    private readonly engine: FuturesEngine,
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

  @UseGuards(JwtAuthGuard)
  @Post('toggle')
  async toggle(@Body() body: { enabled?: boolean }): Promise<FuturesAgentConfigShape> {
    return this.config.setEnabled(body?.enabled !== false);
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
      confirmToken?: string;
    },
  ): Promise<PlaceFuturesOrderResult> {
    const action = body?.action;
    if (action !== 'BUY' && action !== 'SELL' && action !== 'HOLD') {
      throw new BusinessException('BAD_REQUEST', 'action 必须是 BUY / SELL / HOLD');
    }
    return this.trading.placeOrder({
      symbol: body.symbol,
      action,
      type: body.type ?? 'MARKET',
      price: body.price,
      quantity: body.quantity,
      leverage: body.leverage,
      confirmToken: body.confirmToken,
      source: 'manual',
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('orders')
  async listOrders(@Query('limit') limit?: string) {
    return this.trading.list({ limit: Number(limit) || 20 });
  }

  /**
   * 手动触发一次合约决策（与现货链路彼此独立）。
   * 不受熔断限制，便于熔断期间人工介入排查。
   */
  @UseGuards(JwtAuthGuard)
  @Post('run')
  async run() {
    return this.engine.runOnce('manual');
  }

  /** 合约链路健康状态（连续失败次数、冷却截止时间、是否熔断） */
  @UseGuards(JwtAuthGuard)
  @Get('health')
  async health() {
    return { ...this.engine.getHealth(), running: this.engine.isRunning };
  }

  /** 合约决策记录（按 market 隔离，不混入现货） */
  @UseGuards(JwtAuthGuard)
  @Get('decisions')
  async listDecisions(@Query('limit') limit?: string) {
    return this.engine.list({ limit: Number(limit) || 20 });
  }
}
