import {
  FUTURES_TAKER_FEE_RATE,
  settleLotPnl,
  type Candle,
  type LotDirection,
  type LotExitReason,
  type PerfRound,
} from '@ai-trader/shared';
import type {
  OpenLotRequest,
  PlaceStopOrderRequest,
  StrategyExecutor,
  StrategyLotView,
  StrategyOrderView,
} from '../../strategy/types';
import type { BacktestTrade, CostBreakdown } from '../backtest.types';
import type { MarketEvent } from './types';

/**
 * event-driven-v1 撮合器。
 *
 * 与 SimBroker（vectorized）的**语义差异**（都是 StrategyExecutor 实现，策略代码零改动）：
 *
 * | 项目           | vectorized SimBroker       | EventBroker (v1)                    |
 * |---------------|----------------------------|--------------------------------------|
 * | 市价成交时机   | 下一根 bar 开盘             | **下一笔 aggTrade** 成交（真 latency）|
 * | STOP 触发判定 | 每 bar 用 high/low 单次     | **每笔 aggTrade 都检查**（intrabar）  |
 * | 触发成交价     | 用 stopPrice（跳空 max/min） | 用**触发的 aggTrade 实际价**          |
 * | markPrice     | = bar.close                | 来自独立 markPrice 事件                |
 * | funding        | 按 bar 时长分摊常数 rate   | 8h 结算事件精确入账 rate×mark×qty     |
 * | 强平           | 无                         | markPrice 每次 tick 判定分层 MM         |
 *
 * 待 P1b 补：L2 队列 / VWAP 吃深度 / 冲击平方根律 / maker 分档 / latency 20ms。
 */

interface SimLot {
  id: string;
  direction: LotDirection;
  quantity: number;
  entryPrice: number;
  entryFee: number;
  leverage: number;
  openedAt: number;
  status: 'OPEN' | 'CLOSED';
  roundId: string;
  hasPendingClose: boolean;
}

interface SimStop {
  id: string;
  direction: LotDirection;
  stopPrice: number;
  quantity: number;
  leverage: number;
  reason: string;
}

type PendingMarket =
  | { type: 'open'; prelotId: string; req: OpenLotRequest; submittedAt: number }
  | { type: 'close'; lotId: string; reason: LotExitReason; submittedAt: number }
  | { type: 'liquidate'; lotId: string; submittedAt: number };

interface Round {
  id: string;
  lotIds: string[];
  realized: number;
  funding: number;
  openCount: number;
  closedAt: number | null;
  settled: boolean;
}

export interface EventBrokerConfig {
  symbol: string;
  instanceId: string;
  initialCapital: number;
  /** taker 费率（小数单边） */
  feeRate: number;
  /** 兜底滑点（小数单边）：有 aggTrade 时仍叠加，模拟「吃深度」 */
  slippage: number;
  /** 维持保证金率（无 symbol_meta 时的默认，用于强平判定；Binance BTCUSDT 首档 0.4%~0.5%） */
  maintMarginRatio: number;
  /** 强平成交价对 markPrice 的偏离（默认 0.1%） */
  liquidationPenaltyBps?: number;
}

export class EventBroker implements StrategyExecutor {
  private readonly lots = new Map<string, SimLot>();
  private readonly stops = new Map<string, SimStop>();
  private readonly rounds = new Map<string, Round>();
  private readonly pending: PendingMarket[] = [];

  private lotSeq = 0;
  private orderSeq = 0;
  private roundSeq = 0;
  private currentRoundId: string | null = null;

  private realizedCum = 0;
  private fundingCum = 0;
  private feeCum = 0;
  private slipCum = 0;

  /** 事件流推进的内部时钟与市场状态 */
  private lastPrice = 0;
  private lastMark = 0;
  /** 自开运行以来是否至少见过一笔 aggTrade（fallback 判定的权威标志）*/
  private aggSeen = false;

  readonly trades: BacktestTrade[] = [];
  readonly closedRounds: PerfRound[] = [];
  readonly liquidationLog: { ts: number; price: number; qty: number; lotId: string }[] = [];

  constructor(private readonly cfg: EventBrokerConfig) {}

  // ------------------------------------------------------------------ StrategyExecutor 契约

  async openLot(input: OpenLotRequest): Promise<{ lotId: string | null; error?: string }> {
    if (!(input.quantity > 0)) return { lotId: null, error: '开仓数量必须为正' };
    const id = `ev-lot-${(this.lotSeq += 1)}`;
    this.pending.push({ type: 'open', prelotId: id, req: input, submittedAt: this.lastTs });
    return { lotId: id };
  }

  async closeLot(lotId: string, reason: LotExitReason): Promise<{ ok: boolean; error?: string }> {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== 'OPEN') return { ok: false, error: `未找到未完结仓位单（${lotId}）` };
    if (lot.hasPendingClose) return { ok: true };
    lot.hasPendingClose = true;
    this.pending.push({ type: 'close', lotId, reason, submittedAt: this.lastTs });
    return { ok: true };
  }

  async placeStopOrder(
    input: PlaceStopOrderRequest,
  ): Promise<{ orderId: string | null; error?: string }> {
    if (!(input.quantity > 0) || !(input.stopPrice > 0)) {
      return { orderId: null, error: '挂单参数非法' };
    }
    const id = `ev-stop-${(this.orderSeq += 1)}`;
    this.stops.set(id, {
      id,
      direction: input.direction,
      stopPrice: input.stopPrice,
      quantity: input.quantity,
      leverage: input.leverage ?? 3,
      reason: input.reason,
    });
    return { orderId: id };
  }

  async cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
    this.stops.delete(orderId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ 事件驱动主入口

  private lastTs = 0;

  /** 处理一笔事件；返回本事件里触发/成交数量供统计 */
  applyEvent(ev: MarketEvent): { fills: number; stopTriggers: number; liquidations: number } {
    this.lastTs = ev.ts;
    let fills = 0;
    let stopTriggers = 0;
    let liquidations = 0;

    switch (ev.kind) {
      case 'aggTrade': {
        this.lastPrice = ev.price;
        this.aggSeen = true;
        // 1) 兑现 pending（先平后开，避免占额度）；撮合价用**本笔成交实际价**（真 intrabar）
        const drained: PendingMarket[] = [];
        while (this.pending.length) drained.push(this.pending.shift()!);
        for (const p of drained) {
          if (p.type === 'close') {
            this.executeClose(p.lotId, p.reason, ev.price, ev.ts);
            fills += 1;
          } else if (p.type === 'open') {
            this.executeOpen(
              p.prelotId,
              p.req.direction,
              p.req.quantity,
              p.req.leverage ?? 3,
              p.req.reason,
              ev.price,
              ev.ts,
            );
            fills += 1;
          } else if (p.type === 'liquidate') {
            const pen = (this.cfg.liquidationPenaltyBps ?? 10) / 10_000;
            const lot = this.lots.get(p.lotId);
            if (lot && lot.status === 'OPEN') {
              const px = lot.direction === 'LONG' ? ev.price * (1 - pen) : ev.price * (1 + pen);
              // 强平归因为 MARGIN_CALL（非策略止损），与真实 STOP_LOSS 分开便于日志诊断
              this.executeClose(lot.id, 'MARGIN_CALL', px, ev.ts);
              liquidations += 1;
            }
          }
        }
        // 2) STOP 逐笔触发（这是消除"每 bar 单次"失真的核心）
        for (const s of [...this.stops.values()]) {
          const triggered =
            s.direction === 'LONG' ? ev.price >= s.stopPrice : ev.price <= s.stopPrice;
          if (!triggered) continue;
          this.stops.delete(s.id);
          this.executeOpen(s.id, s.direction, s.quantity, s.leverage, s.reason, ev.price, ev.ts);
          stopTriggers += 1;
          fills += 1;
        }
        break;
      }
      case 'markPrice': {
        this.lastMark = ev.markPrice;
        // 强平判定：equity(mark) < maintMarginRatio × Σ|pos| × mark
        const eq = this.equity(this.lastMark);
        const notional = this.positionNotional(this.lastMark);
        const mm = this.cfg.maintMarginRatio * notional;
        if (notional > 0 && eq < mm) {
          // 平所有 OPEN 仓位（按最小损失顺序，这里简化为全部）
          for (const lot of this.lots.values()) {
            if (lot.status !== 'OPEN' || lot.hasPendingClose) continue;
            lot.hasPendingClose = true;
            this.pending.push({ type: 'liquidate', lotId: lot.id, submittedAt: ev.ts });
          }
          this.liquidationLog.push({
            ts: ev.ts,
            price: this.lastMark,
            qty: Math.abs(this.netQty()),
            lotId: '*',
          });
        }
        break;
      }
      case 'fundingSettlement': {
        // rate>0：多头付、空头收。金额 = rate × |qty| × markPrice
        const mark = ev.markPrice || this.lastMark || this.lastPrice;
        let delta = 0;
        for (const lot of this.lots.values()) {
          if (lot.status !== 'OPEN') continue;
          const base = Math.abs(lot.quantity) * mark * ev.rate;
          const signed = lot.direction === 'LONG' ? -base : base;
          delta += signed;
          const round = this.rounds.get(lot.roundId);
          if (round) round.funding += signed;
        }
        if (delta !== 0) {
          this.fundingCum += delta;
          // funding 不写进 trades 数组（保持与 SimBroker 一致、BacktestTrade.kind 仅 OPEN|CLOSE）；
          // 总额在 finalize().costs.totalFunding 体现，每轮归因写入 round.funding（供 basketMetrics）
        }
        break;
      }
      case 'bar': {
        // bar 收盘：无成交动作，仅用于 runner 触发 onTick；若无 aggTrade（fallback）时用 close 兑一次 pending
        if (!this.aggSeen) {
          this.lastPrice = ev.bar.close;
          this.lastMark = ev.bar.close;
          const drained: PendingMarket[] = [];
          while (this.pending.length) drained.push(this.pending.shift()!);
          for (const p of drained) {
            if (p.type === 'close') this.executeClose(p.lotId, p.reason, ev.bar.close, ev.ts);
            else if (p.type === 'open')
              this.executeOpen(
                p.prelotId,
                p.req.direction,
                p.req.quantity,
                p.req.leverage ?? 3,
                p.req.reason,
                ev.bar.close,
                ev.ts,
              );
            else if (p.type === 'liquidate') {
              const lot = this.lots.get(p.lotId);
              // bar fallback 兑现的同样是强平 pending → 归因 MARGIN_CALL
              if (lot) this.executeClose(lot.id, 'MARGIN_CALL', ev.bar.close, ev.ts);
            }
          }
          for (const s of [...this.stops.values()]) {
            const triggered =
              s.direction === 'LONG' ? ev.bar.close >= s.stopPrice : ev.bar.close <= s.stopPrice;
            if (!triggered) continue;
            this.stops.delete(s.id);
            this.executeOpen(s.id, s.direction, s.quantity, s.leverage, s.reason, ev.bar.close, ev.ts);
            stopTriggers += 1;
          }
        }
        break;
      }
    }
    return { fills, stopTriggers, liquidations };
  }

  // ------------------------------------------------------------------ 视图（与 SimBroker 同名同语义，方便 runner 复用）

  /** 供 runner 读取当前 last/mark 价，构造 ctx.price/markPrice */
  prices(): { last: number; mark: number } {
    return { last: this.lastPrice, mark: this.lastMark || this.lastPrice };
  }

  lotViews(mark: number): StrategyLotView[] {
    const out: StrategyLotView[] = [];
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      const dir = lot.direction === 'LONG' ? 1 : -1;
      const unrealizedPnl = Number(
        (dir * (mark - lot.entryPrice) * lot.quantity - lot.entryFee).toFixed(8),
      );
      out.push({
        id: lot.id,
        direction: lot.direction,
        quantity: lot.quantity,
        entryPrice: lot.entryPrice,
        unrealizedPnl,
        entryFeeUsdt: lot.entryFee,
        openedAt: new Date(lot.openedAt).toISOString(),
        hasPendingClose: lot.hasPendingClose,
      });
    }
    return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  orderViews(): StrategyOrderView[] {
    return [...this.stops.values()].map((s) => ({
      id: s.id,
      side: s.direction === 'LONG' ? 'BUY' : 'SELL',
      type: 'STOP_MARKET',
      stopPrice: s.stopPrice,
      quantity: s.quantity,
      exchangeOrderId: null,
    }));
  }

  netQty(): number {
    let q = 0;
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      q += (lot.direction === 'LONG' ? 1 : -1) * lot.quantity;
    }
    return q;
  }

  /** Σ|qty| × mark，用于维持保证金判定 */
  positionNotional(mark: number): number {
    let s = 0;
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      s += Math.abs(lot.quantity) * mark;
    }
    return s;
  }

  equity(mark: number): number {
    let floating = 0;
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      const dir = lot.direction === 'LONG' ? 1 : -1;
      floating += dir * (mark - lot.entryPrice) * lot.quantity - lot.entryFee;
    }
    return Number((this.cfg.initialCapital + this.realizedCum + floating + this.fundingCum).toFixed(8));
  }

  finalize(): { rounds: PerfRound[]; costs: CostBreakdown } {
    return {
      rounds: this.closedRounds,
      costs: {
        totalFees: Number(this.feeCum.toFixed(8)),
        totalSlippage: Number(this.slipCum.toFixed(8)),
        totalFunding: Number(Math.abs(this.fundingCum).toFixed(8)),
      },
    };
  }

  // ------------------------------------------------------------------ 内部成交

  private feeRate(): number {
    return this.cfg.feeRate > 0 ? this.cfg.feeRate : FUTURES_TAKER_FEE_RATE;
  }

  private executeOpen(
    id: string,
    direction: LotDirection,
    quantity: number,
    leverage: number,
    reason: string,
    refPrice: number,
    time: number,
  ): void {
    const slip = this.cfg.slippage;
    const entryPrice = Number(
      (direction === 'LONG' ? refPrice * (1 + slip) : refPrice * (1 - slip)).toFixed(8),
    );
    const entryFee = Number((entryPrice * quantity * this.feeRate()).toFixed(8));
    const slipCost = Number((Math.abs(entryPrice - refPrice) * quantity).toFixed(8));

    const round = this.ensureRound();
    const lot: SimLot = {
      id,
      direction,
      quantity,
      entryPrice,
      entryFee,
      leverage,
      openedAt: time,
      status: 'OPEN',
      roundId: round.id,
      hasPendingClose: false,
    };
    this.lots.set(id, lot);
    round.lotIds.push(id);
    round.openCount += 1;

    this.feeCum += entryFee;
    this.slipCum += slipCost;

    this.trades.push({
      time,
      side: direction === 'LONG' ? 'BUY' : 'SELL',
      kind: 'OPEN',
      price: entryPrice,
      quantity,
      fee: entryFee,
      slippageCost: slipCost,
      direction,
      reason,
      equityAfter: this.equity(entryPrice),
    });
  }

  private executeClose(lotId: string, reason: LotExitReason, refPrice: number, time: number): void {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== 'OPEN') return;
    const slip = this.cfg.slippage;
    const exitPrice = Number(
      (lot.direction === 'LONG' ? refPrice * (1 - slip) : refPrice * (1 + slip)).toFixed(8),
    );
    const exitFee = Number((exitPrice * lot.quantity * this.feeRate()).toFixed(8));
    const slipCost = Number((Math.abs(exitPrice - refPrice) * lot.quantity).toFixed(8));

    const { realizedPnl } = settleLotPnl({
      direction: lot.direction,
      quantity: lot.quantity,
      entryPrice: lot.entryPrice,
      exitPrice,
      entryFee: lot.entryFee,
      exitFee,
    });

    lot.status = 'CLOSED';
    this.realizedCum += realizedPnl;
    this.feeCum += exitFee;
    this.slipCum += slipCost;

    const round = this.rounds.get(lot.roundId);
    if (round) {
      round.realized += realizedPnl;
      round.openCount -= 1;
      round.closedAt = time;
      if (round.openCount <= 0) this.settleRound(round);
    }

    this.trades.push({
      time,
      side: lot.direction === 'LONG' ? 'SELL' : 'BUY',
      kind: 'CLOSE',
      price: exitPrice,
      quantity: lot.quantity,
      fee: exitFee,
      slippageCost: slipCost,
      direction: lot.direction,
      reason,
      exitReason: reason,
      equityAfter: this.equity(exitPrice),
    });
  }

  private ensureRound(): Round {
    if (this.currentRoundId) {
      const r = this.rounds.get(this.currentRoundId);
      if (r && !r.settled) return r;
    }
    const id = `ev-round-${(this.roundSeq += 1)}`;
    const round: Round = {
      id,
      lotIds: [],
      realized: 0,
      funding: 0,
      openCount: 0,
      closedAt: null,
      settled: false,
    };
    this.rounds.set(id, round);
    this.currentRoundId = id;
    return round;
  }

  private settleRound(round: Round): void {
    round.settled = true;
    this.closedRounds.push({
      realizedPnl: Number(round.realized.toFixed(8)),
      fundingFee: Number(round.funding.toFixed(8)),
      closedAt: round.closedAt,
      layerCount: round.lotIds.length,
    });
    if (this.currentRoundId === round.id) this.currentRoundId = null;
  }
}

/** 让 runner 能给一个空 bar 事件预置行情（fallback 场景，无 aggTrade）*/
export function seedFallbackBrokerPrice(broker: EventBroker, bar: Candle): void {
  broker.applyEvent({
    kind: 'aggTrade',
    ts: bar.time,
    price: bar.open,
    qty: 0,
    isBuyerMaker: false,
  });
}
