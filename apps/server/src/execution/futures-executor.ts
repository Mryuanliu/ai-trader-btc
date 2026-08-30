import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_SYMBOL,
  ExecOrderInput,
  ExecOrderView,
  ExecResult,
  ExecutorPositionView,
  FuturesPositionView,
  MarketExecutor,
  MarketType,
  ExchangeCode,
  SymbolFilters,
} from '@ai-trader/shared';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { FuturesPositionService } from '../futures/futures-position.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.adapter';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';

/**
 * 合约执行器：把「策略动作」翻译成合约的开/加/平仓单。
 *
 * 包装 Commit 3 落地的能力：方向语义、杠杆、逐仓保证金、强平距离风控
 * 都在 FuturesTradingService 内，本类只负责把结果映射为跨市场统一视图。
 */
@Injectable()
export class FuturesExecutor implements MarketExecutor {
  private readonly logger = new Logger(FuturesExecutor.name);
  readonly market: MarketType = 'futures';
  readonly exchange: ExchangeCode = 'binance-futures';

  constructor(
    private readonly trading: FuturesTradingService,
    private readonly positions: FuturesPositionService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly registry: ExchangeRegistry,
  ) {}

  /** 合约侧返回可用保证金（USDT），忽略 asset 参数 */
  async getAvailable(_asset?: string): Promise<number> {
    return this.trading.getAvailableMargin();
  }

  async getPosition(symbol: string): Promise<ExecutorPositionView> {
    const view = await this.positions.toView(symbol);
    if (!view) {
      return this.emptyPosition(symbol);
    }
    return {
      symbol: view.symbol,
      market: 'futures',
      quantity: view.quantity,
      side: view.positionSide,
      entryPrice: view.entryPrice,
      marketValue: view.notional,
      unrealizedPnl: view.unrealizedPnl,
      liquidationPrice: view.liquidationPrice,
      leverage: view.leverage,
      marginType: view.marginType,
      liquidationDistancePct: view.liquidationDistancePct,
    };
  }

  async getFilters(symbol: string): Promise<SymbolFilters> {
    const adapter = await this.registry.get('binance-futures');
    return adapter.getSymbolFilters(symbol);
  }

  async placeOrder(input: ExecOrderInput): Promise<ExecResult> {
    const config = await this.futuresConfig.get();
    const symbol = input.symbol || config.symbol || DEFAULT_SYMBOL;

    const result = await this.trading.placeOrder({
      symbol,
      action: input.action,
      type: input.type ?? 'MARKET',
      price: input.price,
      quantity: input.quantity,
      confirmToken: input.confirmToken,
      source: input.source,
      decisionId: input.decisionId ?? null,
    });

    const order = result.order
      ? ({
          id: result.order.id,
          symbol: result.order.symbol,
          side: result.order.side as ExecOrderView['side'],
          type: result.order.type,
          quantity: result.order.quantity,
          price: result.order.price,
          status: result.order.status,
          filledQuantity: result.order.filledQuantity,
          filledPrice: result.order.filledPrice,
          exchangeOrderId: result.order.exchangeOrderId,
          error: result.order.error,
        } satisfies ExecOrderView)
      : null;

    return {
      order,
      risk: result.risk,
      note: result.order ? undefined : result.risk.note,
      detail: {
        leverage: result.leverage,
        positionSide:
          result.intent.kind === 'hold' ? null : (result.intent.positionSide ?? null),
        reduceOnly: result.intent.kind === 'hold' ? null : result.intent.reduceOnly,
        margin: result.sizing.margin,
        notional: result.sizing.notional,
      },
    };
  }

  private emptyPosition(symbol: string): ExecutorPositionView {
    return {
      symbol,
      market: 'futures',
      quantity: 0,
      side: null,
      entryPrice: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      liquidationPrice: null,
      leverage: null,
      marginType: null,
      liquidationDistancePct: null,
    };
  }
}

/** 便于上层做能力收窄：判断某执行器是否为合约执行器 */
export function isFuturesExecutor(executor: MarketExecutor): boolean {
  return executor.market === 'futures';
}
