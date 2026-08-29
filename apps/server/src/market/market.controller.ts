import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  Candle,
  DEFAULT_SYMBOL,
  MarketPulse,
  TIMEFRAMES,
  Ticker,
  Timeframe,
} from '@ai-trader/shared';
import { MarketService } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get('candles')
  async candles(
    @Query('symbol') symbol = DEFAULT_SYMBOL,
    @Query('interval') interval: Timeframe = '5m',
    @Query('limit') limit = '300',
  ): Promise<Candle[]> {
    const safeInterval = (TIMEFRAMES as readonly string[]).includes(interval) ? interval : '5m';
    return this.market.getCandles(symbol, safeInterval as Timeframe, Number(limit) || 300);
  }

  @Get('ticker/:symbol')
  async ticker(@Param('symbol') symbol: string): Promise<Ticker> {
    return this.market.getTicker(symbol);
  }

  @Get('ticker')
  async defaultTicker(@Query('symbol') symbol = DEFAULT_SYMBOL): Promise<Ticker> {
    return this.market.getTicker(symbol);
  }

  @Get('pulse')
  async pulse(@Query('symbol') symbol = DEFAULT_SYMBOL): Promise<MarketPulse> {
    return this.market.getMarketPulse(symbol);
  }

  @Get('status')
  async status() {
    return this.market.status;
  }
}
