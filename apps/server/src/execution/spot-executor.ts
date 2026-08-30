import { Injectable, Logger } from '@nestjs/common';
import {
  checkSpotMinQty,
  computeSpotOrderQty,
  DEFAULT_SYMBOL,
  EMPTY_EXEC_DETAIL,
  ExchangeCode,
  ExecOrderInput,
  ExecOrderView,
  ExecResult,
  ExecutorPositionView,
  MarketExecutor,
  MarketType,
  OrderSide,
  SymbolFilters,
} from '@ai-trader/shared';
import { TradingService } from '../trading/trading.service';
import { AccountService } from '../account/account.service';
import { PositionService } from '../account/position.service';
import { AgentConfigService } from '../agent/agent-config.service';
import { MarketService } from '../market/market.service';

/**
 * 现货执行器：把「策略动作」翻译成现货买卖单。
 *
 * 定位是**包装**而非重写：
 * - 数量公式复用 shared 的 computeSpotOrderQty（与 AgentEngine 现网逻辑同源）
 * - 下单仍走 TradingService 的唯一出口（风控、取整、落库全在那里）
 * 因此现货的下单行为与改造前完全一致，本类不引入任何新的业务判断。
 */
@Injectable()
export class SpotExecutor implements MarketExecutor {
  private readonly logger = new Logger(SpotExecutor.name);
  readonly market: MarketType = 'spot';
  /** 现货交易所可在配置里切换，故用 getter 而非常量 */
  readonly exchange: ExchangeCode = 'binance';

  constructor(
    private readonly trading: TradingService,
    private readonly accounts: AccountService,
    private readonly positions: PositionService,
    private readonly agentConfig: AgentConfigService,
    private readonly marketData: MarketService,
  ) {}

  /** 可用余额：不传资产时返回计价资产 USDT */
  async getAvailable(asset = 'USDT'): Promise<number> {
    const { rows } = await this.loadBalances();
    return rows.filter((r) => r.asset === asset).reduce((acc, r) => acc + r.free, 0);
  }

  async getPosition(symbol: string): Promise<ExecutorPositionView> {
    const position = await this.positions.getPosition(symbol);
    return {
      symbol,
      market: 'spot',
      quantity: position.quantity,
      // 现货只有多头，无方向概念
      side: null,
      entryPrice: position.avgCost,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
      // 现货无杠杆 / 保证金 / 强平
      liquidationPrice: null,
      leverage: null,
      marginType: null,
      liquidationDistancePct: null,
    };
  }

  async getFilters(symbol: string): Promise<SymbolFilters> {
    return this.trading.getFilters(symbol);
  }

  async placeOrder(input: ExecOrderInput): Promise<ExecResult> {
    const config = await this.agentConfig.get();
    const symbol = input.symbol || config.symbol || DEFAULT_SYMBOL;

    if (input.action === 'HOLD') {
      return this.skipped('HOLD', '策略输出观望');
    }

    // 数量推导需要参考价；限价单用传入价，市价单取实时行情
    this.marketData.ensureSymbol(symbol);
    const price = input.price ?? this.marketData.getTicker(symbol).price ?? 0;
    if (!(price > 0)) {
      return this.skipped('INVALID_PRICE', '无法获取当前价格');
    }

    const { rows } = await this.loadBalances();
    const quoteFree = rows.filter((r) => r.asset === 'USDT').reduce((a, r) => a + r.free, 0);
    const baseFree = rows.filter((r) => r.asset === 'BTC').reduce((a, r) => a + r.free, 0);

    const quantity = computeSpotOrderQty({
      action: input.action,
      quoteFree,
      baseFree,
      positionPct: config.positionPct,
      price,
      positionMultiplier: input.positionMultiplier,
      closeAll: input.closeAll,
    });

    if (!(quantity > 0)) {
      const note =
        input.action === 'SELL'
          ? '无持仓可卖，本轮跳过'
          : '可用资金不足或 positionPct 过小，本轮跳过';
      return this.skipped('INSUFFICIENT_BALANCE', note);
    }

    // 最小下单量预检：数量不足时直接跳过，不进入下单流程
    const filters = await this.getFilters(symbol);
    const minCheck = checkSpotMinQty(quantity, filters);
    if (!minCheck.ok) {
      return this.skipped('MIN_QTY', minCheck.note ?? '下单量不足最小单位');
    }

    const side: OrderSide = input.action === 'BUY' ? 'BUY' : 'SELL';
    const { order, risk } = await this.trading.placeOrder({
      symbol,
      side,
      type: input.type ?? 'MARKET',
      // 传未取整的数量：TradingService 内部用 normalizeOrder 做权威取整与风控，
      // 与 AgentEngine 现有调用方式保持一致
      quantity,
      price: input.price,
      source: input.source,
      decisionId: input.decisionId ?? null,
      confirmToken: input.confirmToken,
    });

    return { order: toOrderView(order), risk, detail: { ...EMPTY_EXEC_DETAIL } };
  }

  private async loadBalances() {
    const config = await this.agentConfig.get();
    return this.accounts.getBalances(config.mode, config.enabledExchanges);
  }

  private skipped(rejectedBy: string, note: string): ExecResult {
    return {
      order: null,
      risk: { passed: false, rejectedBy, note },
      note,
      detail: { ...EMPTY_EXEC_DETAIL },
    };
  }
}

export function toOrderView(order: {
  id: string;
  symbol: string;
  side: OrderSide;
  type: string;
  quantity: number;
  price: number;
  status: string;
  filledQuantity: number;
  filledPrice: number;
  exchangeOrderId: string | null;
  error: string | null;
}): ExecOrderView {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type as ExecOrderView['type'],
    quantity: order.quantity,
    price: order.price,
    status: order.status,
    filledQuantity: order.filledQuantity,
    filledPrice: order.filledPrice,
    exchangeOrderId: order.exchangeOrderId,
    error: order.error,
  };
}
