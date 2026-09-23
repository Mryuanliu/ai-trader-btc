import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AiMarketAnalysis } from '@ai-trader/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiMarketService } from './ai-market.service';

/**
 * AI 行情分析接口（独立页面）。
 *
 * 只读接口：输出市场解读，不触发任何交易。
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiMarketController {
  constructor(private readonly ai: AiMarketService) {}

  /** 取行情分析；`force=true` 绕过 60s 缓存重新调用模型 */
  @Get('market')
  async market(
    @Query('symbol') symbol = 'BTCUSDT',
    @Query('force') force?: string,
  ): Promise<AiMarketAnalysis> {
    return this.ai.analyze(symbol, force === 'true');
  }
}
