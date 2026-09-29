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
} from '../strategy/types';
import type { BacktestTrade, CostBreakdown } from './backtest.types';

/** 回测内部仓位单（内存账本，对应实盘的 PositionLotEntity） */
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

/** 挂起中的 STOP 触发单（网格待成交层） */
interface SimStop {
  id: string;
  direction: LotDirection;
  stopPrice: number;
  quantity: number;
  leverage: number;
  reason: string;
}

/** 待下根开盘成交的市价动作（onTick 提交，beginBar 兑现） */
type PendingMarket =
  | { type: 'open'; prelotId: string; req: OpenLotRequest }
  | { type: 'close'; lotId: string; reason: LotExitReason };

/** 一轮「建仓 → 全平」（对应实盘篮子），是绩效计算的最小单元 */
interface Round {
  id: string;
  lotIds: string[];
  realized: number;
  funding: number;
  openCount: number;
  closedAt: number | null;
  settled: boolean;
}

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export interface SimBrokerConfig {
  symbol: string;
  instanceId: string;
  initialCapital: number;
  /** taker 费率（小数，单边），默认 FUTURES_TAKER_FEE_RATE */
  feeRate: number;
  /** 滑点（小数，单边，恒对成交方不利） */
  slippage: number;
  /** 每 8h 资金费率（小数），按持仓名义随时间近似累加；0 关闭 */
  fundingPctPer8h: number;
  /** 单根 K 线的毫秒跨度，用于资金费按时间分摊 */
  intervalMs: number;
}

/**
 * 回测撮合器：**实现与实盘完全同构的 `StrategyExecutor` 接口**，
 * 让策略一行不改就能在历史 K 线上跑（parity 的落点）。
 *
 * 成交约定（与历史报告 fillConvention='next-open' 一致，且杜绝前视）：
 * - 市价开/平仓（`openLot`/`closeLot`）在 `onTick` 内只是**受理**，
 *   实际以**下一根 bar 的开盘价**成交（策略决策只看得到已闭合的 bar）。
 * - STOP 触发单（`placeStopOrder`）在后续 bar 用 **high/low** 判定穿越，
 *   触发价成交并处理跳空（BUY 取 max(stopPrice, open)、SELL 取 min(stopPrice, open)）。
 * - 滑点恒对成交方不利（BUY 抬价、SELL 压价）；开/平各按 taker 费率双边计费。
 */
export class SimBroker implements StrategyExecutor {
  private readonly lots = new Map<string, SimLot>();
  private readonly stops = new Map<string, SimStop>();
  private readonly rounds = new Map<string, Round>();
  private readonly pending: PendingMarket[] = [];

  private lotSeq = 0;
  private orderSeq = 0;
  private roundSeq = 0;

  /** 当前未完结的篮子（单 symbol 同一时刻至多一个 OPEN 轮，与实盘 attach 规则一致） */
  private currentRoundId: string | null = null;

  private realizedCum = 0;
  private fundingCum = 0;
  private feeCum = 0;
  private slipCum = 0;

  readonly trades: BacktestTrade[] = [];
  readonly closedRounds: PerfRound[] = [];

  constructor(private readonly cfg: SimBrokerConfig) {}

  private feeRate(): number {
    return this.cfg.feeRate > 0 ? this.cfg.feeRate : FUTURES_TAKER_FEE_RATE;
  }

  // ------------------------------------------------------------------ StrategyExecutor（策略调用）

  async openLot(
    input: OpenLotRequest,
  ): Promise<{ lotId: string | null; error?: string }> {
    if (!(input.quantity > 0)) return { lotId: null, error: '开仓数量必须为正' };
    // 受理并预分配 id；真实成交价在下一根 bar 开盘兑现
    const id = `sim-lot-${(this.lotSeq += 1)}`;
    this.pending.push({ type: 'open', prelotId: id, req: input });
    return { lotId: id };
  }

  async closeLot(lotId: string, reason: LotExitReason): Promise<{ ok: boolean; error?: string }> {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== 'OPEN') return { ok: false, error: `未找到未完结仓位单（${lotId}）` };
    if (lot.hasPendingClose) return { ok: true }; // 已在途，避免重复平（与实盘同语义）
    lot.hasPendingClose = true;
    this.pending.push({ type: 'close', lotId, reason });
    return { ok: true };
  }

  async placeStopOrder(
    input: PlaceStopOrderRequest,
  ): Promise<{ orderId: string | null; error?: string }> {
    if (!(input.quantity > 0) || !(input.stopPrice > 0)) {
      return { orderId: null, error: '挂单参数非法' };
    }
    const id = `sim-stop-${(this.orderSeq += 1)}`;
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

  // ------------------------------------------------------------------ runner 每根 bar 驱动

  /** 处理一根 bar：先兑现上一 tick 受理的市价单，再用高低价触发 STOP */
  beginBar(bar: Candle): void {
    // 1) 平仓（先平后开，释放槽位）
    for (const p of this.pending) {
      if (p.type === 'close') this.executeClose(p.lotId, p.reason, bar.open, bar.time);
    }
    // 2) 市价开仓，以本 bar 开盘成交
    for (const p of this.pending) {
      if (p.type === 'open') {
        this.executeOpen(p.prelotId, p.req.direction, p.req.quantity, p.req.leverage ?? 3, p.req.reason, bar.open, bar.time);
      }
    }
    this.pending.length = 0;

    // 3) 触发挂起 STOP（用本 bar 高低价）
    for (const s of [...this.stops.values()]) {
      const triggered =
        s.direction === 'LONG' ? bar.high >= s.stopPrice : bar.low <= s.stopPrice;
      if (!triggered) continue;
      this.stops.delete(s.id);
      this.executeOpen(s.id, s.direction, s.quantity, s.leverage, s.reason, s.stopPrice, bar.time, bar.open);
    }

    // 4) 资金费按本 bar 时长分摊（默认 rate=0 时跳过）
    this.accrueFunding(bar);
  }

  // ------------------------------------------------------------------ 视图（供 runner 构造 StrategyContext）

  /** 未完结仓位单视图（浮盈按判定价 mark 计，扣除开仓费——与 lot.service.toDTO 同口径） */
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

  /** 挂起 STOP 视图 */
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

  /** 账户净值：初始本金 + 已实现 + 未实现浮盈(扣开仓费) + 累计资金费 */
  equity(mark: number): number {
    let floating = 0;
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      const dir = lot.direction === 'LONG' ? 1 : -1;
      floating += dir * (mark - lot.entryPrice) * lot.quantity - lot.entryFee;
    }
    return Number((this.cfg.initialCapital + this.realizedCum + floating + this.fundingCum).toFixed(8));
  }

  // ------------------------------------------------------------------ 收尾

  /** 汇总成本与已了结轮次，供 runner 出报告 */
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

  private executeOpen(
    id: string,
    direction: LotDirection,
    quantity: number,
    leverage: number,
    reason: string,
    basePrice: number,
    time: number,
    gapOpen?: number,
  ): void {
    // STOP 处理跳空：BUY 取 max(stop, open)、SELL 取 min(stop, open)；市价单 basePrice 即 open
    let refPrice = basePrice;
    if (gapOpen !== undefined) {
      refPrice = direction === 'LONG' ? Math.max(basePrice, gapOpen) : Math.min(basePrice, gapOpen);
    }
    // 滑点恒不利：买入抬价、卖出压价
    const slip = this.cfg.slippage;
    const entryPrice = Number((direction === 'LONG' ? refPrice * (1 + slip) : refPrice * (1 - slip)).toFixed(8));
    const qty = quantity;
    const entryFee = Number((entryPrice * qty * this.feeRate()).toFixed(8));
    const slipCost = Number((Math.abs(entryPrice - refPrice) * qty).toFixed(8));

    const round = this.ensureRound();
    const lot: SimLot = {
      id,
      direction,
      quantity: qty,
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
      quantity: qty,
      fee: entryFee,
      slippageCost: slipCost,
      direction,
      reason,
      equityAfter: this.equity(entryPrice),
    });
  }

  private executeClose(lotId: string, reason: LotExitReason, basePrice: number, time: number): void {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== 'OPEN') return;
    // 平仓滑点同样不利：多头平(卖)压价、空头平(买)抬价
    const slip = this.cfg.slippage;
    const exitPrice = Number((lot.direction === 'LONG' ? basePrice * (1 - slip) : basePrice * (1 + slip)).toFixed(8));
    const exitFee = Number((exitPrice * lot.quantity * this.feeRate()).toFixed(8));
    const slipCost = Number((Math.abs(exitPrice - basePrice) * lot.quantity).toFixed(8));

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

  private accrueFunding(bar: Candle): void {
    if (!(this.cfg.fundingPctPer8h > 0)) return;
    const frac = this.cfg.intervalMs / FUNDING_INTERVAL_MS;
    for (const lot of this.lots.values()) {
      if (lot.status !== 'OPEN') continue;
      const base = Math.abs(lot.quantity) * bar.close * this.cfg.fundingPctPer8h * frac;
      // 正费率：多头付、空头收
      const signed = lot.direction === 'LONG' ? -base : base;
      this.fundingCum += signed;
      const round = this.rounds.get(lot.roundId);
      if (round) round.funding += signed;
    }
  }

  private ensureRound(): Round {
    if (this.currentRoundId) {
      const r = this.rounds.get(this.currentRoundId);
      if (r && !r.settled) return r;
    }
    const id = `sim-round-${(this.roundSeq += 1)}`;
    const round: Round = { id, lotIds: [], realized: 0, funding: 0, openCount: 0, closedAt: null, settled: false };
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
