import { Injectable, Logger } from '@nestjs/common';
import type { LotExitReason } from '@ai-trader/shared';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { LotService } from '../account/lot.service';
import type {
  OpenLotRequest,
  PlaceStopOrderRequest,
  StrategyExecutor,
} from './types';

/**
 * 策略执行器：把策略意图翻译成平台的下单调用。
 *
 * 这里是策略**唯一**的交易入口——策略不能直接碰交易所适配器，
 * 否则下单记账、成交对账、Lot 结算都会漏掉。
 */
@Injectable()
export class StrategyExecutorService implements StrategyExecutor {
  private readonly logger = new Logger(StrategyExecutorService.name);

  constructor(
    private readonly trading: FuturesTradingService,
    private readonly lots: LotService,
  ) {}

  /** 市价开仓（带 TP/SL 快照；篮子出场模式下通常传 0 表示不设逐层止盈） */
  async openLot(input: OpenLotRequest): Promise<{ lotId: string | null; error?: string }> {
    try {
      const result = await this.trading.placeOrder({
        // 合约语义：BUY 恒开多 / SELL 恒开空（hedge mode 下多空可共存）
        action: input.direction === 'LONG' ? 'BUY' : 'SELL',
        quantity: input.quantity,
        // 策略声明的杠杆优先于平台配置
        leverage: input.leverage,
        source: 'strategy',
      });
      if (!result.order) {
        return { lotId: null, error: '下单未产生订单（被前置校验拦下）' };
      }
      // 真实成交可能延迟（demo 环境响应常无成交量），Lot 由对账任务补建，
      // 此时返回 null——策略下一 tick 会从 ctx.openLots 看到它，不影响正确性。
      const lot = await this.lots.findByOpenOrderId(result.order.id);
      return { lotId: lot?.id ?? null };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`策略开仓失败（${input.direction} ${input.quantity}）：${message}`);
      return { lotId: null, error: message };
    }
  }

  /** 全量平掉指定仓位单（Lot 模型：一个 Lot 必须一次平完，不做部分平仓） */
  async closeLot(lotId: string, reason: LotExitReason): Promise<{ ok: boolean; error?: string }> {
    try {
      const lot = await this.lots.getOpenLot(lotId);
      if (!lot) return { ok: false, error: `未找到未完结仓位单（${lotId}）` };
      await this.trading.placeOrder({
        action: lot.direction === 'LONG' ? 'SELL' : 'BUY',
        lotId,
        source: 'strategy',
        exitReason: reason,
      });
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`策略平仓失败（lot=${lotId}）：${message}`);
      return { ok: false, error: message };
    }
  }

  /** 挂 STOP 触发单：网格的待成交层（交易所负责触发，我们不轮询） */
  async placeStopOrder(
    input: PlaceStopOrderRequest,
  ): Promise<{ orderId: string | null; error?: string }> {
    try {
      const order = await this.trading.placeStopOrder({
        side: input.direction === 'LONG' ? 'BUY' : 'SELL',
        positionSide: input.direction,
        stopPrice: input.stopPrice,
        quantity: input.quantity,
        leverage: input.leverage,
        source: 'strategy',
        note: input.reason,
      });
      return { orderId: order.id };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`策略挂单失败（${input.reason} @ ${input.stopPrice}）：${message}`);
      return { orderId: null, error: message };
    }
  }

  /** 撤单（网格重排 / 篮子出场前清理） */
  async cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.trading.cancelOrder(orderId);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`策略撤单失败（${orderId}）：${message}`);
      return { ok: false, error: message };
    }
  }
}
