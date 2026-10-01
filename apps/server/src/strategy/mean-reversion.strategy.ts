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
  riskPerTradePct: 0.5,
  sizingAtrMult: 1,
  maxLeverage: 10,
  baseQty: 0.01,
  // 布林带（中轨 SMA + ±K·σ 轨道）
  bollingerPeriod: 20,
  bollingerK: 2.0,
  // RSI-2 超买超卖确认（Connors 口径：简单 n 期涨跌均值法）
  rsiPeriod: 2,
  rsiBuyMax: 10, // LONG 需 RSI ≤ 此值（超卖）
  rsiSellMin: 90, // SHORT 需 RSI ≥ 此值（超买）
  // L2 regime 门控：|EMA_fast − EMA_slow| / ATR > regimeMax 视为趋势市 → 不做回归
  regimeEmaFast: 10,
  regimeEmaSlow: 50,
  regimeMax: 0.5,
  // 出场兜底：入场轨道外 stopAtrMult·ATR 硬止损 + 时间止损
  stopAtrMult: 2.0,
  maxHoldBars: 24,
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
    bollingerPeriod: { type: 'integer', title: '布林带周期', minimum: 5, maximum: 100 },
    bollingerK: { type: 'number', title: '布林带标准差倍数', minimum: 0.5, maximum: 4 },
    rsiPeriod: { type: 'integer', title: 'RSI 周期', minimum: 1, maximum: 30 },
    rsiBuyMax: { type: 'number', title: 'RSI 超卖阈值(LONG)', minimum: 0, maximum: 50 },
    rsiSellMin: { type: 'number', title: 'RSI 超买阈值(SHORT)', minimum: 50, maximum: 100 },
    regimeEmaFast: { type: 'integer', title: 'regime 快 EMA', minimum: 2, maximum: 100 },
    regimeEmaSlow: { type: 'integer', title: 'regime 慢 EMA', minimum: 5, maximum: 300 },
    regimeMax: { type: 'number', title: '趋势强度上限(|快-慢|/ATR)', minimum: 0, maximum: 5 },
    stopAtrMult: { type: 'number', title: '硬止损 ATR 倍数', minimum: 0.5, maximum: 10 },
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
  bollingerPeriod: number;
  bollingerK: number;
  rsiPeriod: number;
  rsiBuyMax: number;
  rsiSellMin: number;
  regimeEmaFast: number;
  regimeEmaSlow: number;
  regimeMax: number;
  stopAtrMult: number;
  maxHoldBars: number;
  leverage: number;
  atrMinPct: number;
  cooldownSec: number;
}

/** 开仓时快照的入场布林带（出场判定基准，避免用当前带漂移） */
interface EntryRefs {
  upper: number;
  lower: number;
  mid: number;
}

/**
 * 均值回归策略（B0 · 布林带偏离 + RSI-2 确认 + 震荡 regime 门控）。
 *
 * 定位：与趋势族（trend_following / donchian_breakout）负相关的方向性族——
 * **只在震荡市做、趋势市空仓**，直击趋势策略「震荡市反复打脸」的根因。
 *
 * 逻辑：
 * 1. 有持仓 → 每 tick 检查：**回归中轨止盈 → ATR 硬止损 → 时间止损**（优先级从上到下）
 * 2. 空仓 & 冷却期外 → warmup 足够 →
 *    - regime 门控：`|EMA_fast − EMA_slow| / ATR > regimeMax` → 趋势市，不开回归仓
 *    - 信号：`mark < 下轨 且 RSI ≤ rsiBuyMax` → LONG；`mark > 上轨 且 RSI ≥ rsiSellMin` → SHORT
 * 3. 仓位走 computeRiskScaledQty（L1 复用）；默认单仓，不做逆势加仓摊平（规避负偏尾部）
 *
 * Parity：全部判定走 `ctx.now`（回测墙钟），不引 `Date.now()`；布林/regime/RSI 全基于
 * `candles.slice(0,-1)` 排除未收盘的最后一根（消除前视）。触发价用 `ctx.markPrice`（防插针）。
 */
@Injectable()
export class MeanReversionStrategy implements TradingStrategy {
  private readonly logger = new Logger(MeanReversionStrategy.name);

  readonly name = 'mean_reversion';
  readonly label = '均值回归';
  readonly description =
    '布林带偏离 + RSI-2 超买超卖双确认入场，仅在震荡 regime 启用；出场走回归中轨止盈 + ATR 硬止损 + 时间止损；仓位波动率定标，默认单仓不摊平。';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;
  // 上架元信息（capabilities/riskNotes/version）只存在于磁盘 strategies/mean-reversion/manifest.json，
  // 由 StrategyHub 从磁盘加载并覆盖——对齐 donchian/trend 既有约定（类内不声明 manifest 字段）。

  /** 上次平仓时间（冷却） */
  private lastCloseAt = 0;
  /** 每 Lot 的开仓时间（时间止损） */
  private entryTimes = new Map<string, number>();
  /** 每 Lot 的入场布林带快照（止盈/止损基准） */
  private entryRefs = new Map<string, EntryRefs>();
  private lastNote = '';

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const src = raw ?? {};
    const num = (key: string, min: number, max: number): number => {
      const v = Number(src[key]);
      if (!Number.isFinite(v)) return DEFAULT_PARAMS[key] as number;
      return Math.min(max, Math.max(min, v));
    };
    const int = (key: string, min: number, max: number): number =>
      Math.floor(num(key, min, max));
    const bool = (key: string): boolean => {
      const v = src[key];
      if (v === undefined) return DEFAULT_PARAMS[key] as boolean;
      return Boolean(v);
    };
    const fast = int('regimeEmaFast', 2, 100);
    const slow = int('regimeEmaSlow', 5, 300);
    return {
      useVolSizing: bool('useVolSizing'),
      riskPerTradePct: num('riskPerTradePct', 0.05, 5),
      sizingAtrMult: num('sizingAtrMult', 0.5, 5),
      maxLeverage: int('maxLeverage', 1, 20),
      baseQty: num('baseQty', 0.0001, 1000),
      bollingerPeriod: int('bollingerPeriod', 5, 100),
      bollingerK: num('bollingerK', 0.5, 4),
      rsiPeriod: int('rsiPeriod', 1, 30),
      rsiBuyMax: num('rsiBuyMax', 0, 50),
      rsiSellMin: num('rsiSellMin', 50, 100),
      regimeEmaFast: fast,
      // 慢 EMA 必须 > 快 EMA，否则 regime 判据无意义
      regimeEmaSlow: Math.max(slow, fast + 1),
      regimeMax: num('regimeMax', 0, 5),
      stopAtrMult: num('stopAtrMult', 0.5, 10),
      maxHoldBars: int('maxHoldBars', 1, 10_000),
      leverage: int('leverage', 1, 20),
      atrMinPct: num('atrMinPct', 0, 0.2),
      cooldownSec: int('cooldownSec', 0, 3600),
    };
  }

  onStart(_params: Record<string, unknown>): void {
    this.lastCloseAt = 0;
    this.entryTimes.clear();
    this.entryRefs.clear();
    this.lastNote = '已启动（布林带均值回归 · 震荡门控）';
  }

  onStop(): void {
    this.entryTimes.clear();
    this.entryRefs.clear();
    this.lastNote = '';
  }

  getState(): Record<string, unknown> {
    return {
      note: this.lastNote,
      lastCloseAt: this.lastCloseAt,
      trackedLots: this.entryRefs.size,
    };
  }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const p = ctx.params as unknown as NormalizedParams;

    // ---- 1. 持仓：回归中轨止盈 → ATR 硬止损 → 时间止损 ----
    if (ctx.openLots.length > 0) {
      const intervalMs = this.inferIntervalMs(ctx);
      const closed = ctx.candles.slice(0, -1);
      const closes = closed.map((c) => c.close);
      const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
      for (const lot of ctx.openLots) {
        if (!this.entryTimes.has(lot.id)) {
          this.entryTimes.set(lot.id, lot.openedAt ? Date.parse(lot.openedAt) : ctx.now);
        }
        // 缺入场快照（如接管的历史 Lot）：用当前布林带惰性补一份，避免无法止盈/止损
        if (!this.entryRefs.has(lot.id)) {
          const band = this.bollinger(closes, p.bollingerPeriod, p.bollingerK);
          if (band) this.entryRefs.set(lot.id, band);
        }
        const exit = this.decideExit(lot, ctx, p, intervalMs, mark);
        if (!exit.shouldClose) continue;
        const r = await exec.closeLot(lot.id, exit.reason);
        if (r.ok) {
          this.lastCloseAt = ctx.now;
          this.entryRefs.delete(lot.id);
          this.entryTimes.delete(lot.id);
          this.lastNote = `${exit.reason}平仓（${lot.direction} ${lot.quantity}）— ${exit.note}`;
          this.logger.log(this.lastNote);
        } else {
          this.logger.warn(`均值回归平仓失败 lot=${lot.id}: ${r.error}`);
        }
      }
      return;
    }

    // ---- 2. 冷却 ----
    if (ctx.now - this.lastCloseAt < p.cooldownSec * 1000) {
      this.lastNote = `平仓冷却中（${p.cooldownSec} 秒）`;
      return;
    }

    // ---- 3. warmup & ATR 就绪 ----
    if (!(ctx.atr > 0)) {
      this.lastNote = 'ATR 未就绪，跳过';
      return;
    }
    const closed = ctx.candles.slice(0, -1);
    const warmup = Math.max(p.bollingerPeriod, p.regimeEmaSlow, p.rsiPeriod + 1);
    if (closed.length < warmup + 1) {
      this.lastNote = `K 线不足（需 ≥ ${warmup + 1} 根收盘），等待数据`;
      return;
    }
    const closes = closed.map((c) => c.close);
    const mark = ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
    if (p.atrMinPct > 0 && mark > 0 && ctx.atr / mark < p.atrMinPct) {
      this.lastNote = `低波过滤：atr/mark=${(ctx.atr / mark).toFixed(4)} < ${p.atrMinPct}`;
      return;
    }

    // ---- 4. regime 门控：趋势市（|快-慢|/ATR > regimeMax）不做回归 ----
    const emaFast = this.ema(closes, p.regimeEmaFast);
    const emaSlow = this.ema(closes, p.regimeEmaSlow);
    if (emaFast == null || emaSlow == null) {
      this.lastNote = 'regime EMA 未就绪，跳过';
      return;
    }
    const trendRatio = Math.abs(emaFast - emaSlow) / ctx.atr;
    if (trendRatio > p.regimeMax) {
      this.lastNote = `趋势市（ratio=${trendRatio.toFixed(3)} > ${p.regimeMax}），不做均值回归`;
      return;
    }

    // ---- 5. 信号：布林带破轨 + RSI-2 双确认 ----
    const band = this.bollinger(closes, p.bollingerPeriod, p.bollingerK);
    if (!band) {
      this.lastNote = '布林带计算无结果，跳过';
      return;
    }
    const rsi = this.rsi(closes, p.rsiPeriod);
    if (rsi == null) {
      this.lastNote = 'RSI 未就绪，跳过';
      return;
    }

    let dir: 'LONG' | 'SHORT' | null = null;
    if (mark < band.lower && rsi <= p.rsiBuyMax) dir = 'LONG';
    else if (mark > band.upper && rsi >= p.rsiSellMin) dir = 'SHORT';
    if (!dir) {
      this.lastNote =
        `无回归信号（mark=${mark.toFixed(2)} 带[${band.lower.toFixed(2)}, ${band.upper.toFixed(2)}], rsi=${rsi.toFixed(1)}）`;
      return;
    }

    // ---- 6. 仓位定标 ----
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
      reason: 'mean-reversion',
    });
    if (r.error) {
      this.lastNote = `开仓失败：${r.error}`;
      this.logger.warn(this.lastNote);
      return;
    }
    if (r.lotId) {
      this.entryTimes.set(r.lotId, ctx.now);
      this.entryRefs.set(r.lotId, { upper: band.upper, lower: band.lower, mid: band.mid });
    }
    this.lastNote = `回归开 ${dir}（带[${band.lower.toFixed(2)}, ${band.upper.toFixed(2)}], rsi=${rsi.toFixed(1)}, trendRatio=${trendRatio.toFixed(3)}, ${sizingNote}）`;
    this.logger.log(this.lastNote);
  }

  /**
   * 出场优先级：回归中轨止盈 → ATR 硬止损 → 时间止损。
   * 止盈/止损基准用开仓时快照的布林带（entryRefs）；缺快照则不判 TP/SL，仅走时间止损。
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
    mark: number,
  ): { shouldClose: boolean; reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL'; note: string } {
    const refs = this.entryRefs.get(lot.id);
    if (refs) {
      // (a) 回归中轨止盈
      if (lot.direction === 'LONG' && mark >= refs.mid) {
        return { shouldClose: true, reason: 'TAKE_PROFIT', note: `回到中轨 ${refs.mid.toFixed(2)} 止盈` };
      }
      if (lot.direction === 'SHORT' && mark <= refs.mid) {
        return { shouldClose: true, reason: 'TAKE_PROFIT', note: `回到中轨 ${refs.mid.toFixed(2)} 止盈` };
      }
      // (b) ATR 硬止损（越过入场轨道再往外 stopAtrMult·ATR）
      if (lot.direction === 'LONG' && mark < refs.lower - p.stopAtrMult * ctx.atr) {
        return {
          shouldClose: true,
          reason: 'STOP_LOSS',
          note: `跌破下轨止损（< ${(refs.lower - p.stopAtrMult * ctx.atr).toFixed(2)}）`,
        };
      }
      if (lot.direction === 'SHORT' && mark > refs.upper + p.stopAtrMult * ctx.atr) {
        return {
          shouldClose: true,
          reason: 'STOP_LOSS',
          note: `突破上轨止损（> ${(refs.upper + p.stopAtrMult * ctx.atr).toFixed(2)}）`,
        };
      }
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

  /** 最近 n 根收盘价的布林带：中轨 SMA(n)、上下轨 ± k·总体标准差；不足 n 返回 null */
  private bollinger(
    closes: number[],
    n: number,
    k: number,
  ): EntryRefs | null {
    if (closes.length < n || n <= 0) return null;
    const slice = closes.slice(-n);
    const mean = slice.reduce((a, b) => a + b, 0) / n;
    const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const sd = Math.sqrt(variance);
    return { mid: mean, upper: mean + k * sd, lower: mean - k * sd };
  }

  /** 简单 EMA（前 period 根用 SMA 播种，其后递推）；不足返回 null */
  private ema(closes: number[], period: number): number | null {
    if (closes.length < period || period <= 0) return null;
    const k = 2 / (period + 1);
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i += 1) {
      e = closes[i] * k + e * (1 - k);
    }
    return e;
  }

  /** RSI（Connors 简单 n 期涨跌均值法，用最近 period 根涨跌幅）；不足返回 null */
  private rsi(closes: number[], period: number): number | null {
    if (closes.length < period + 1 || period <= 0) return null;
    let gain = 0;
    let loss = 0;
    for (let i = closes.length - period; i < closes.length; i += 1) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gain += diff;
      else loss += -diff;
    }
    const avgGain = gain / period;
    const avgLoss = loss / period;
    if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
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
