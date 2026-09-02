import { Controller, Get, Param, Query } from '@nestjs/common';
import type { MarketType } from '@ai-trader/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import { MarketService } from '../market/market.service';
import { LotService } from './lot.service';

/**
 * 仓位单（Lot）查询：持仓页 Lot 列表、交易面板「选择要平的 Lot」、订单页分组。
 * 只读接口；Lot 的建立与结算只由成交回调触发，不暴露写入口。
 */
@Controller('lots')
@UseGuards(JwtAuthGuard)
export class LotsController {
  constructor(
    private readonly lots: LotService,
    private readonly market: MarketService,
  ) {}

  /** Lot 列表：status=open 只看持仓中（交易面板平仓选择器用） */
  @Get()
  async list(
    @Query('market') market?: MarketType,
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
  ) {
    const m: MarketType = market === 'futures' ? 'futures' : 'spot';
    const currentPrice = await this.getSymbolPrice(m, symbol);

    if (status === 'open') {
      const rows = await this.lots.listOpen(m, symbol);
      return rows.map((r) => this.lots.toDTO(r, currentPrice ?? undefined));
    }

    // status=all 或省略：全量（含 CLOSED/CANCELLED）——订单页按 Lot 分组、对账用
    const rows = await this.lots.listAll(m, symbol);
    return rows.map((r) => this.lots.toDTO(r, currentPrice ?? undefined));
  }

  /** 单个 Lot（含按现价的浮动盈亏） */
  @Get(':id')
  async get(@Param('id') id: string, @Query('market') market?: MarketType) {
    const lot = await this.lots.getOpenLot(id);
    if (!lot) return null;
    const m: MarketType = market === 'futures' ? 'futures' : 'spot';
    const price = await this.getSymbolPrice(m, lot.symbol);
    return this.lots.toDTO(lot, price ?? undefined);
  }

  private async getSymbolPrice(market: MarketType, symbol?: string): Promise<number | null> {
    if (!symbol) return null;
    try {
      // 本地行情：取不到（未订阅/降级中）返回 null，DTO 的浮动盈亏为 null
      const price = this.market.getTicker(symbol).price;
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}
