import { Injectable, Logger } from '@nestjs/common';
import { computeRiskScaledQty } from '@ai-trader/shared';
import type {
  StrategyContext,
  StrategyExecutor,
  TradingStrategy,
} from './types';

const DEFAULT_PARAMS: Record<string, unknown> = {
  // L1 波动率定标仓位（复用 shared 引擎）
  useVolSizing: true,
  // 回测台 walk-forward 调优（4h×~2y，2026-10-01）：默认参 OOS 回撤 14%超阀，
  // 降到 riskPerTradePct=0.25 + 紧吊灯止损后 OOS 回撤降到 <7%、Sharpe 转正。
  riskPerTradePct: 0.25,
  sizingAtrMult: 1,
  maxLeverage: 10,
  baseQty: 0.01,
  // Donchian 通道参数
  breakoutLookbackBars: 20, // 入场通道（Turtle 短周期 20，长周期 55）
  exitLookbackBars: 15, // 出场通道（反向破位；调优后略长于原 10，配合紧吊灯斩尾）
  // L3 吊灯 + 时间止损（与 trend_following 同族）
  chandelierK: 2, // 吊灯止损收紧到 2×ATR（原 4）：快止损斩断假突破的尾部回撤
  maxHoldBars: 240,
  // 兜底杠杆（useVolSizing=false 时用）
  leverage: 10,
  // 低波过滤：atr/markPrice < atrMinPct 时不开新仓；默认 0（关）
  atrMinPct: 0,
  // 平仓后冷却
  cooldownSec: 60,
};

const PARAM_SCHEMA = {
  type: 'object',
  properties: {
    useVolSizing: { type: 'boolean', title: '启用波动率定标' },
    riskPerTradePct: { type: 'number', title: '单笔风险预算(%)', minimum: 0.05, maximum: 5 },
    sizingAtrMult: { type: 'number', title: '定标 ATR 倍数', minimum: 0.5, maximum: 5 },
    maxLeverage: { type: 'integer', title: '最大杠杆', minimum: 1, maximum: 20 },
    baseQty: { type: 'number', title: '固定数量(关闭定标时)', minimum: 0.0001 },
    breakoutLookbackBars: { type: 'integer', title: '入场通道根数', minimum: 5, maximum: 200 },
    exitLookbackBars: { type: 'integer', title: '出场通道根数', minimum: 2, maximum: 100 },
    chandelierK: { type: 'number', title: '吊灯 ATR 倍数', minimum: 1, maximum: 10 },
    maxHoldBars: { type: 'integer', title: '时间止损(根数)', minimum: 1, maximum: 10_000 },
    leverage: { type: 'integer', title: '杠杆(旧)', minimum: 1, maximum: 20 },
    atrMinPct: { type: 'number', title: '低波过滤阈值(atr/mark)', minimum: 0, maximum: 0.2 },
    cooldownSec: { type: 'integer', title: '平仓后冷却(秒)', minimum: 0, maximum: 3600 },
  },
} as const;

interface NormalizedParams {
  useVolSizing: boolean;
  riskPerTradePct: number;
  sizingAtrMult: number;
  maxLeverage: number;
  baseQty: number;
  breakoutLookbackBars: number;
  exitLookbackBars: number;
  chandelierK: number;
  maxHoldBars: number;
  leverage: number;
  atrMinPct: number;
  cooldownSec: number;
}

/**
 * 唐奇安通道突破策略（Donchian Breakout / Turtle 风格）。
 *
 * 与双均线趋势跟踪的差别：入场信号走「N 根 K 线通道破位」而不是均线交叉。
 * Turtle 几十年实盘验证：突破 = 高波动 + 方向确定，天然是 regime 触发器。
 *
 * 逻辑：
 * 1. 有持仓 → 每 tick 检查：**反向通道破位 → 吊灯 → 时间止损**（优先级从上到下）
 * 2. 空仓 & 冷却期外 → 判突破：
 *    - `markPrice > max(high of last breakoutLookbackBars 已收盘 bar)` → LONG
 *    - `markPrice < min(low  of last breakoutLookbackBars 已收盘 bar)` → SHORT
 * 3. 仓位走 computeRiskScaledQty（L1 复用），出场走 ATR 吊灯 + 时间（L3 复用）
 *
 * Parity：全部判定走 `ctx.now`（回测墙钟），不引 `Date.now()`；通道计算排除未收盘的最后一根。
 * 触发价用 `ctx.markPrice`（防插针，符合已有「止盈止损用标记价规范」）。
 */
@Injectable()
export class DonchianBreakoutStrategy implements TradingStrategy {
  private readonly logger = new Logger(DonchianBreakoutStrategy.name);

  readonly name = 'donchian_breakout';
  readonly label = '唐奇安突破';
  readonly description =
    'N 根 K 线通道突破入场（Turtle 风格）+ 反向 M 根通道破位出场；仓位走波动率定标，兜底走 ATR 吊灯 + 时间止损。';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;

  /** 上次平仓时间（冷却） */
  private lastCloseAt = 0;
  /** 每 Lot 的吊灯位（单调） */
  private chandelierStops = new Map<string, number>();
  /** 每 Lot 的开仓时间（时间止损） */
  private entryTimes = new Map<string, number>();
  private lastNote = '';

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const src = raw ?? {};
    const num = (key: string, min: number, max: number): number => {
      const v = Number(src[key]);
      if (!Number.isFinite(v)) return DEFAULT_PARAMS[key] as number;
      return Math.min(max, Math.max(min, v));
    };
    const bool = (key: string): boolean => {
      const v = src[key];
      if (v === undefined) return DEFAULT_PARAMS[key] as boolean;
      return Boolean(v);
    };
    const brk = Math.floor(num('breakoutLookbackBars', 5, 200));
    const ex = Math.floor(num('exitLookbackBars', 2, 100));
    return {
      useVolSizing: bool('useVolSizing'),
      riskPerTradePct: num('riskPerTradePct', 0.05, 5),
      sizingAtrMult: num('sizingAtrMult', 0.5, 5),
      maxLeverage: Math.floor(num('maxLeverage', 1, 20)),
      baseQty: num('baseQty', 0.0001, 1000),
      breakoutLookbackBars: brk,
      // 出场通道必须 <= 入场通道，否则等于永远不出场
      exitLookbackBars: Math.min(ex, brk),
      chandelierK: num('chandelierK', 1, 10),
      maxHoldBars: Math.floor(num('maxHoldBars', 1, 10_000)),
      leverage: Math.floor(num('leverage', 1, 20)),
      atrMinPct: num('atrMinPct', 0, 0.2),
      cooldownSec: Math.floor(num('cooldownSec', 0, 3600)),
    };
  }

  onStart(_params: Record<string, unknown>): void {
    this.lastCloseAt = 0;
    this.chandelierStops.clear();
    this.entryTimes.clear();
    this.lastNote = '已启动（唐奇安通道突破）';
  }

  onStop(): void {
    this.chandelierStops.clear();
    this.entryTimes.clear();
    this.lastNote = '';
  }

  getState(): Record<string, unknown> {
    return {
      note: this.lastNote,
      lastCloseAt: this.lastCloseAt,
      trackedLots: this.chandelierStops.size,
    };
  }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const p = ctx.params as unknown as NormalizedParams;

    // ---- 1. 持仓：反向通道破位 → 吊灯 → 时间止损 ----
    if (ctx.openLots.length > 0) {
      const intervalMs = this.inferIntervalMs(ctx);
      // 排除未收盘的最后一根：用 ctx.candles[0..n-1) 计算通道
      const closed = ctx.candles.slice(0, -1);
      const exitChannel = this.computeChannel(closed, p.exitLookbackBars);
      for (const lot of ctx.openLots) {
        if (!this.entryTimes.has(lot.id)) {
          this.entryTimes.set(lot.id, lot.openedAt ? Date.parse(lot.openedAt) : ctx.now);
        }
        const exit = this.decideExit(lot, ctx, p, intervalMs, exitChannel);
        if (!exit.shouldClose) continue;
        const r = await exec.closeLot(lot.id, exit.reason);
        if (r.ok) {
          this.lastCloseAt = ctx.now;
          this.chandelierStops.delete(lot.id);
          this.entryTimes.delete(lot.id);
          this.lastNote = `${exit.reason}平仓（${lot.direction} ${lot.quantity}）— ${exit.note}`;
          this.logger.log(this.lastNote);
        } else {
          this.logger.warn(`唐奇安平仓失败 lot=${lot.id}: ${r.error}`);
        }
      }
      return;
    }

    // ---- 2. 冷却 ----
    if (ctx.now - this.lastCloseAt < p.cooldownSec * 1000) {
      this.lastNote = `平仓冷却中（${p.cooldownSec} 秒）`;
      return;
    }

    // ---- 3. 通道 & 低波过滤 ----
    if (!(ctx.atr > 0)) {
      this.lastNote = 'ATR 未就绪，跳过';
      return;
    }
    const closed = ctx.candles.slice(0, -1);
    if (closed.length < p.breakoutLookbackBars) {
      this.lastNote = 'K 线不足，等待数据';
      return;
    }
    const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
    if (p.atrMinPct > 0 && mark > 0 && ctx.atr / mark < p.atrMinPct) {
      this.lastNote = `低波过滤：atr/mark=${(ctx.atr / mark).toFixed(4)} < ${p.atrMinPct}`;
      return;
    }

    const entryChannel = this.computeChannel(closed, p.breakoutLookbackBars);
    if (!entryChannel) {
      this.lastNote = '通道计算无结果，跳过';
      return;
    }

    let dir: 'LONG' | 'SHORT' | null = null;
    if (mark > entryChannel.upper) dir = 'LONG';
    else if (mark < entryChannel.lower) dir = 'SHORT';
    if (!dir) {
      this.lastNote = `价格在通道内 [${entryChannel.lower.toFixed(2)}, ${entryChannel.upper.toFixed(2)}]，未突破`;
      return;
    }

    // ---- 4. 仓位定标 ----
    let quantity = p.baseQty;
    let leverage = p.leverage;
    let sizingNote = `固定 qty=${p.baseQty}`;
    if (p.useVolSizing) {
      const sized = computeRiskScaledQty({
        equity: ctx.availableMargin,
        atr: ctx.atr,
        markPrice: mark,
        riskPerTradePct: p.riskPerTradePct,
        atrMult: p.sizingAtrMult,
        maxLeverage: p.maxLeverage,
      });
      if (!(sized.quantity > 0)) {
        this.lastNote = `仓位定标返回 0（equity=${ctx.availableMargin} atr=${ctx.atr} mark=${mark}），跳过`;
        return;
      }
      quantity = sized.quantity;
      leverage = sized.leverage;
      sizingNote = `定标 qty=${quantity.toFixed(6)} notional=${sized.notional.toFixed(0)}U lev=${leverage}x`;
    }

    const r = await exec.openLot({
      direction: dir,
      quantity,
      leverage,
      reason: 'donchian-breakout',
    });
    if (r.error) {
      this.lastNote = `开仓失败：${r.error}`;
      this.logger.warn(this.lastNote);
      return;
    }
    if (r.lotId) {
      this.entryTimes.set(r.lotId, ctx.now);
      const initStop = dir === 'LONG' ? mark - p.chandelierK * ctx.atr : mark + p.chandelierK * ctx.atr;
      this.chandelierStops.set(r.lotId, initStop);
    }
    this.lastNote = `突破开 ${dir}（通道 [${entryChannel.lower.toFixed(2)}, ${entryChannel.upper.toFixed(2)}]，${sizingNote}）`;
    this.logger.log(this.lastNote);
  }

  /**
   * 出场优先级：反向通道破位 → 吊灯 → 时间止损。
   * 反向通道是 Turtle 的经典出场——上破开多后，若 markPrice 跌破 exitLookbackBars 的最低价即平。
   */
  private decideExit(
    lot: {
      id: string;
      direction: 'LONG' | 'SHORT';
      quantity: number;
      entryPrice: number;
      unrealizedPnl: number;
    },
    ctx: StrategyContext,
    p: NormalizedParams,
    intervalMs: number,
    exitChannel: { upper: number; lower: number } | null,
  ): { shouldClose: boolean; reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL'; note: string } {
    const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;

    // (a) 反向通道破位
    if (exitChannel) {
      if (lot.direction === 'LONG' && mark < exitChannel.lower) {
        return {
          shouldClose: true,
          reason: 'SIGNAL',
          note: `反向通道破位（下沿 ${exitChannel.lower.toFixed(2)}）`,
        };
      }
      if (lot.direction === 'SHORT' && mark > exitChannel.upper) {
        return {
          shouldClose: true,
          reason: 'SIGNAL',
          note: `反向通道破位（上沿 ${exitChannel.upper.toFixed(2)}）`,
        };
      }
    }

    // (b) 吊灯：更新 stop（单调），触发即平
    const prev = this.chandelierStops.get(lot.id);
    let newStop: number;
    if (lot.direction === 'LONG') {
      const candidate = mark - p.chandelierK * ctx.atr;
      newStop = prev === undefined ? candidate : Math.max(prev, candidate);
    } else {
      const candidate = mark + p.chandelierK * ctx.atr;
      newStop = prev === undefined ? candidate : Math.min(prev, candidate);
    }
    this.chandelierStops.set(lot.id, newStop);
    if (lot.direction === 'LONG' && mark <= newStop) {
      return { shouldClose: true, reason: 'STOP_LOSS', note: `吊灯 stop ${newStop.toFixed(2)} 触发` };
    }
    if (lot.direction === 'SHORT' && mark >= newStop) {
      return { shouldClose: true, reason: 'STOP_LOSS', note: `吊灯 stop ${newStop.toFixed(2)} 触发` };
    }

    // (c) 时间止损
    const entry = this.entryTimes.get(lot.id) ?? ctx.now;
    const heldMs = ctx.now - entry;
    if (heldMs >= p.maxHoldBars * intervalMs) {
      return {
        shouldClose: true,
        reason: 'SIGNAL',
        note: `时间止损 ${p.maxHoldBars} 根（已持 ${Math.floor(heldMs / intervalMs)} 根）`,
      };
    }
    return { shouldClose: false, reason: 'STOP_LOSS', note: '' };
  }

  /**
   * 计算最近 n 根**已收盘** K 线的通道：upper = max(high)、lower = min(low)。
   * 数据不足返回 null；调用方需先 slice(0, -1) 排除未收盘的最后一根。
   */
  private computeChannel(
    closed: StrategyContext['candles'],
    n: number,
  ): { upper: number; lower: number } | null {
    if (closed.length < n || n <= 0) return null;
    let upper = Number.NEGATIVE_INFINITY;
    let lower = Number.POSITIVE_INFINITY;
    for (let i = closed.length - n; i < closed.length; i += 1) {
      const c = closed[i];
      if (c.high > upper) upper = c.high;
      if (c.low < lower) lower = c.low;
    }
    if (!Number.isFinite(upper) || !Number.isFinite(lower)) return null;
    return { upper, lower };
  }

  /** 从 ctx.candles 相邻两根时间差推 intervalMs；不足 2 根则用 5m 兜底 */
  private inferIntervalMs(ctx: StrategyContext): number {
    const cs = ctx.candles;
    if (cs.length >= 2) {
      const d = cs[cs.length - 1].time - cs[cs.length - 2].time;
      if (d > 0) return d;
    }
    return 300_000;
  }
}
