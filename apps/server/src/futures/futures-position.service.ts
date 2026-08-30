import { Injectable, Logger } from '@nestjs/common';
import {
  FuturesPositionView,
  FuturesPositionSnapshot,
  PositionSide,
} from '@ai-trader/shared';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.adapter';

/**
 * 合约持仓服务：以交易所 positionRisk 为权威，不在本地推导。
 *
 * 与现货 PositionService（由成交明细推导成本均价）口径不同：
 * 合约是净持仓模型，可做空、有保证金与强平价，
 * 本地推导无法还原交易所的保证金与强平计算，必须由交易所给出。
 */
@Injectable()
export class FuturesPositionService {
  private readonly logger = new Logger(FuturesPositionService.name);

  constructor(private readonly registry: ExchangeRegistry) {}

  private async adapter(): Promise<BinanceFuturesAdapter> {
    const adapter = await this.registry.get('binance-futures');
    if (!(adapter instanceof BinanceFuturesAdapter)) {
      throw new Error('binance-futures 适配器类型不符');
    }
    return adapter;
  }

  /** 全部合约持仓（含空仓标的） */
  async listPositions(symbol?: string): Promise<FuturesPositionSnapshot[]> {
    const adapter = await this.adapter();
    return adapter.getPositions(symbol);
  }

  /**
   * 指定标的的净持仓数量：正=多头，负=空头，0=无持仓。
   * 取不到时返回 0 而不是抛错——持仓查询失败不应让整个决策链路崩溃，
   * 交由风控在下单前再次校验。
   */
  async getNetQuantity(symbol: string): Promise<number> {
    try {
      const rows = await this.listPositions(symbol);
      const row = rows.find((r) => r.symbol === symbol);
      return row?.quantity ?? 0;
    } catch (err) {
      this.logger.warn(`读取 ${symbol} 合约持仓失败，按无持仓处理: ${(err as Error).message}`);
      return 0;
    }
  }

  /** 前端展示用持仓视图 */
  async toView(symbol: string): Promise<FuturesPositionView | null> {
    const rows = await this.listPositions(symbol);
    const row = rows.find((r) => r.symbol === symbol);
    if (!row) return null;

    return {
      symbol: row.symbol,
      market: 'futures',
      quantity: row.quantity,
      positionSide: positionSideOf(row.quantity),
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      liquidationPrice: row.liquidationPrice,
      leverage: row.leverage,
      marginType: row.marginType,
      isolatedMargin: row.isolatedMargin,
      unrealizedPnl: row.unrealizedPnl,
      notional: row.notional,
      liquidationDistancePct: row.liquidationDistancePct,
    };
  }
}

export function positionSideOf(quantity: number): PositionSide | null {
  if (quantity > 0) return 'LONG';
  if (quantity < 0) return 'SHORT';
  return null;
}
