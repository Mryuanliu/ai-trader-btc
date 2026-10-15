import { Injectable, Logger } from '@nestjs/common';
import { computeRiskScaledQty, ema } from '@ai-trader/shared';
import type {
  StrategyContext,
  StrategyExecutor,
  TradingStrategy,
} from './types';

const DEFAULT_PARAMS: Record<string, unknown> = {
  // L1 波动率定标仓位（P1 主线）
  useVolSizing: true,
  riskPerTradePct: 0.5,
  sizingAtrMult: 1,
  maxLeverage: 10,
  // 关闭 L1 时的固定数量（对照组）
  baseQty: 0.01,
  // 均线
  emaFast: 9,
  emaSlow: 21,
  // L2 regime 门控：|fast-slow| / atr < regimeMin 视为非趋势
  regimeMin: 0.35,
  // L3 ATR 吊灯 & 时间止损
  chandelierK: 3,
  maxHoldBars: 120,
  // 兼容旧参数：固定比例止盈止损
  takeProfitPct: 0.02,
  stopLossPct: 0.01,
  // 旧 regime 判据（保留兼容，regimeMin 生效时此项被覆盖）
  minTrendStrength: 0.0015,
  // 兜底杠杆（useVolSizing=false 时用）
  leverage: 10,
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
    emaFast: { type: 'integer', title: '快线周期', minimum: 2, maximum: 100 },
    emaSlow: { type: 'integer', title: '慢线周期', minimum: 3, maximum: 200 },
    regimeMin: { type: 'number', title: 'Regime 阈值(|fast-slow|/ATR)', minimum: 0, maximum: 5 },
    chandelierK: { type: 'number', title: '吊灯 ATR 倍数', minimum: 1, maximum: 10 },
    maxHoldBars: { type: 'integer', title: '时间止损(根数)', minimum: 1, maximum: 10_000 },
    takeProfitPct: { type: 'number', title: '止盈(比例)', minimum: 0.0005, maximum: 0.5 },
    stopLossPct: { type: 'number', title: '止损(比例)', minimum: 0.0005, maximum: 0.5 },
    minTrendStrength: { type: 'number', title: '最小趋势强度(旧)', minimum: 0 },
    leverage: { type: 'integer', title: '杠杆(旧)', minimum: 1, maximum: 20 },
    cooldownSec: { type: 'integer', title: '平仓后冷却(秒)', minimum: 0, maximum: 3600 },
  },
} as const;

interface NormalizedParams {
  useVolSizing: boolean;
  riskPerTradePct: number;
  sizingAtrMult: number;
  maxLeverage: number;
  baseQty: number;
  emaFast: number;
  emaSlow: number;
  regimeMin: number;
  chandelierK: number;
  maxHoldBars: number;
  takeProfitPct: number;
  stopLossPct: number;
  minTrendStrength: number;
  leverage: number;
  cooldownSec: number;
}

/**
 * 趋势跟踪策略（P1 三件套升级：L1 波动率定标 + L2 regime 门控 + L3 ATR 吊灯/时间止损）。
 *
 * 逻辑：
 * 1. 有持仓 → 每 tick 检查：吊灯 stop（单调）/ 时间止损 / 固定止盈止损
 * 2. 空仓 & 冷却期外 → 判 regime（|EMA 差| / ATR ≥ regimeMin），不达则不开新仓
 * 3. 通过 regime → 走 computeRiskScaledQty 定标数量；useVolSizing=false 回退 baseQty
 *
 * 定位不变：「不拦截」，仓位引擎是脚手架，策略自主 opt-in（`useVolSizing` 参数控制）。
 * Parity：吊灯/时间判定全走 `ctx.now`（回测的墙钟），不引 Date.now()。
 */
@Injectable()
export class TrendFollowingStrategy implements TradingStrategy {
  private readonly logger = new Logger(TrendFollowingStrategy.name);

  readonly name = 'trend_following';
  readonly label = '趋势跟踪';
  readonly description =
    '双均线判趋势方向 + regime 门控过滤震荡；顺势开一单，波动率定标仓位；出场用 ATR 吊灯 + 时间止损（可选固定止盈）+ 冷却。';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;

  /** 上次平仓时间（冷却） */
  private lastCloseAt = 0;
  /** 每 Lot 的吊灯位（单调，LONG 只升 / SHORT 只降） */
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
    const fast = Math.floor(num('emaFast', 2, 100));
    const slow = Math.floor(num('emaSlow', 3, 200));
    return {
      useVolSizing: bool('useVolSizing'),
      riskPerTradePct: num('riskPerTradePct', 0.05, 5),
      sizingAtrMult: num('sizingAtrMult', 0.5, 5),
      maxLeverage: Math.floor(num('maxLeverage', 1, 20)),
      baseQty: num('baseQty', 0.0001, 1000),
      emaFast: Math.min(fast, slow - 1),
      emaSlow: Math.max(slow, fast + 1),
      regimeMin: num('regimeMin', 0, 5),
      chandelierK: num('chandelierK', 1, 10),
      maxHoldBars: Math.floor(num('maxHoldBars', 1, 10_000)),
      takeProfitPct: num('takeProfitPct', 0.0005, 0.5),
      stopLossPct: num('stopLossPct', 0.0005, 0.5),
      minTrendStrength: num('minTrendStrength', 0, 0.1),
      leverage: Math.floor(num('leverage', 1, 20)),
      cooldownSec: Math.floor(num('cooldownSec', 0, 3600)),
    };
  }

  onStart(_params: Record<string, unknown>): void {
    this.lastCloseAt = 0;
    this.chandelierStops.clear();
    this.entryTimes.clear();
    this.lastNote = '已启动（波动率定标 + regime + 吊灯）';
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

    // ---- 1. 持仓中：吊灯 / 时间 / 固定止盈止损 ----
    if (ctx.openLots.length > 0) {
      // intervalMs 从 ctx.candles 相邻两根 time 差推得（不引 ctx 未带字段）
      const intervalMs = this.inferIntervalMs(ctx);
      for (const lot of ctx.openLots) {
        // 在途平仓去重：已有 reduceOnly 平单未结算时不再重复下平仓单（对齐马丁 hasPendingClose 闸）。
        if (lot.hasPendingClose) continue;
        // 记录 entryTime（首见）
        if (!this.entryTimes.has(lot.id)) {
          this.entryTimes.set(lot.id, lot.openedAt ? Date.parse(lot.openedAt) : ctx.now);
        }
        const exit = this.decideExit(lot, ctx, p, intervalMs);
        if (!exit.shouldClose) continue;
        const r = await exec.closeLot(lot.id, exit.reason);
        if (r.ok) {
          this.lastCloseAt = ctx.now;
          this.chandelierStops.delete(lot.id);
          this.entryTimes.delete(lot.id);
          this.lastNote = `${exit.reason}平仓（${lot.direction} ${lot.quantity}）— ${exit.note}`;
          this.logger.log(this.lastNote);
        } else {
          this.logger.warn(`趋势策略平仓失败 lot=${lot.id}: ${r.error}`);
        }
      }
      return;
    }

    // ---- 2. 冷却 ----
    if (ctx.now - this.lastCloseAt < p.cooldownSec * 1000) {
      this.lastNote = `平仓冷却中（${p.cooldownSec} 秒）`;
      return;
    }

    // ---- 3. 趋势判定 ----
    const closes = ctx.candles.map((c) => c.close);
    if (closes.length < p.emaSlow + 2) {
      this.lastNote = 'K 线不足，等待数据';
      return;
    }
    const fast = ema(closes, p.emaFast);
    const slow = ema(closes, p.emaSlow);
    if (!(fast > 0) || !(slow > 0)) {
      this.lastNote = '均线计算无结果，跳过';
      return;
    }

    // ---- 4. Regime 门控（L2）：|fast-slow| / atr ≥ regimeMin ----
    if (!(ctx.atr > 0)) {
      this.lastNote = 'ATR 未就绪，跳过';
      return;
    }
    const spread = Math.abs(fast - slow);
    const regimeRatio = spread / ctx.atr;
    if (regimeRatio < p.regimeMin) {
      this.lastNote = `非趋势 regime（spread/atr=${regimeRatio.toFixed(3)} < ${p.regimeMin}），不开仓`;
      return;
    }

    // ---- 5. 仓位定标（L1）----
    const dir = fast > slow ? 'LONG' : 'SHORT';
    let quantity = p.baseQty;
    let leverage = p.leverage;
    let sizingNote = `固定 qty=${p.baseQty}`;
    if (p.useVolSizing) {
      const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
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
      reason: 'trend-entry',
    });
    if (r.error) {
      this.lastNote = `开仓失败：${r.error}`;
      this.logger.warn(this.lastNote);
      return;
    }
    // 记录首见（lotId 可能因异步成交返回 null；下 tick 从 openLots 补齐）
    if (r.lotId) {
      this.entryTimes.set(r.lotId, ctx.now);
      // 初始化吊灯：以当前 mark 为基准
      const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
      const initStop = dir === 'LONG' ? mark - p.chandelierK * ctx.atr : mark + p.chandelierK * ctx.atr;
      this.chandelierStops.set(r.lotId, initStop);
    }
    this.lastNote = `顺势开 ${dir}（regime=${regimeRatio.toFixed(3)}，${sizingNote}）`;
    this.logger.log(this.lastNote);
  }

  /**
   * 出场判定优先级：吊灯 → 时间 → 固定止盈/止损。
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
  ): { shouldClose: boolean; reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL'; note: string } {
    const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;

    // (a) 吊灯：更新 stop（单调），触发即平
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

    // (b) 时间止损
    const entry = this.entryTimes.get(lot.id) ?? ctx.now;
    const heldMs = ctx.now - entry;
    if (heldMs >= p.maxHoldBars * intervalMs) {
      return {
        shouldClose: true,
        reason: 'SIGNAL',
        note: `时间止损 ${p.maxHoldBars} 根（已持 ${Math.floor(heldMs / intervalMs)} 根）`,
      };
    }

    // (c) 固定止盈止损（保留兼容）
    const notional = lot.entryPrice * lot.quantity;
    if (notional > 0) {
      const pnlPct = lot.unrealizedPnl / notional;
      if (pnlPct >= p.takeProfitPct) {
        return { shouldClose: true, reason: 'TAKE_PROFIT', note: `止盈 ${(pnlPct * 100).toFixed(2)}%` };
      }
      if (pnlPct <= -p.stopLossPct) {
        return { shouldClose: true, reason: 'STOP_LOSS', note: `固定止损 ${(pnlPct * 100).toFixed(2)}%` };
      }
    }
    return { shouldClose: false, reason: 'STOP_LOSS', note: '' };
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
