import { Injectable, Logger } from '@nestjs/common';
import { ema } from '@ai-trader/shared';
import type {
  StrategyContext,
  StrategyExecutor,
  TradingStrategy,
} from './types';

const DEFAULT_PARAMS: Record<string, unknown> = {
  baseQty: 0.01,
  emaFast: 9,
  emaSlow: 21,
  // 止盈 2% / 止损 1%：盈亏比 2:1，靠胜率覆盖止损成本
  takeProfitPct: 0.02,
  stopLossPct: 0.01,
  // 快慢线偏离小于此值视为「无趋势」（震荡），不开仓
  minTrendStrength: 0.0015,
  leverage: 10,
  // 平仓后冷却，避免刚止损就被同一个假信号再拉进去
  cooldownSec: 60,
};

const PARAM_SCHEMA = {
  type: 'object',
  properties: {
    baseQty: { type: 'number', title: '单次开仓数量(BTC)', minimum: 0.0001 },
    emaFast: { type: 'integer', title: '快线周期', minimum: 2, maximum: 100 },
    emaSlow: { type: 'integer', title: '慢线周期', minimum: 3, maximum: 200 },
    takeProfitPct: { type: 'number', title: '止盈(比例)', minimum: 0.0005, maximum: 0.5 },
    stopLossPct: { type: 'number', title: '止损(比例)', minimum: 0.0005, maximum: 0.5 },
    minTrendStrength: { type: 'number', title: '最小趋势强度', minimum: 0 },
    leverage: { type: 'integer', title: '杠杆', minimum: 1, maximum: 20 },
    cooldownSec: { type: 'integer', title: '平仓后冷却(秒)', minimum: 0, maximum: 3600 },
  },
} as const;

/**
 * 趋势跟踪策略（P1 的第二个示例，用于实证「策略可插拔」）。
 *
 * 与马丁网格**思路完全相反**，以此证明平台不绑定任何单一策略范式：
 * - 马丁：逆势加仓摊薄成本，靠回归获利，敞口随层数放大
 * - 本策略：**顺势开仓、绝不加仓**，靠趋势段获利，单笔亏损即全部止损
 *
 * 逻辑：
 * 1. 无持仓 → 双均线判定方向与强度，趋势明确才顺势开一单
 * 2. 有持仓 → 只做止盈/止损判定，达到任一阈值即全平
 * 3. 平仓后进入冷却，避免震荡行情里被反复打脸
 *
 * 出场用**逐单固定止盈止损**（不是篮子整体），
 * 因为本策略一次只持一个方向、一单，篮子聚合意义不大。
 */
@Injectable()
export class TrendFollowingStrategy implements TradingStrategy {
  private readonly logger = new Logger(TrendFollowingStrategy.name);

  readonly name = 'trend_following';
  readonly label = '趋势跟踪';
  readonly description =
    '双均线判定趋势方向，顺势开仓并带固定止盈止损；趋势反转时反手。与马丁网格思路相反——不逆势加仓，靠趋势段获利。';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;

  /** 上一次平仓时间（冷却用） */
  private lastCloseAt = 0;
  private lastNote = '';

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const src = raw ?? {};
    const num = (key: string, min: number, max: number): number => {
      const v = Number(src[key]);
      if (!Number.isFinite(v)) return DEFAULT_PARAMS[key] as number;
      return Math.min(max, Math.max(min, v));
    };
    const fast = Math.floor(num('emaFast', 2, 100));
    const slow = Math.floor(num('emaSlow', 3, 200));
    return {
      baseQty: num('baseQty', 0.0001, 1000),
      // 快线必须快于慢线，否则「金叉/死叉」失去意义
      emaFast: Math.min(fast, slow - 1),
      emaSlow: Math.max(slow, fast + 1),
      takeProfitPct: num('takeProfitPct', 0.0005, 0.5),
      stopLossPct: num('stopLossPct', 0.0005, 0.5),
      minTrendStrength: num('minTrendStrength', 0, 0.1),
      leverage: Math.floor(num('leverage', 1, 20)),
      cooldownSec: Math.floor(num('cooldownSec', 0, 3600)),
    };
  }

  onStart(): void {
    this.lastCloseAt = 0;
    this.lastNote = '已启动（顺势开仓，带固定止盈止损）';
  }

  onStop(): void {
    this.lastNote = '';
  }

  getState(): Record<string, unknown> {
    return { note: this.lastNote, lastCloseAt: this.lastCloseAt };
  }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const p = ctx.params as {
      baseQty: number;
      emaFast: number;
      emaSlow: number;
      takeProfitPct: number;
      stopLossPct: number;
      minTrendStrength: number;
      leverage: number;
      cooldownSec: number;
    };

    // ---- 1. 持仓中：只做止盈止损判定 ----
    if (ctx.openLots.length > 0) {
      for (const lot of ctx.openLots) {
        const { shouldClose, reason } = this.checkExit(lot, p);
        if (!shouldClose) continue;
        const r = await exec.closeLot(lot.id, reason);
        if (r.ok) {
          this.lastCloseAt = Date.now();
          this.lastNote = `${reason === 'TAKE_PROFIT' ? '止盈' : '止损'}平仓（${lot.direction} ${lot.quantity}）`;
          this.logger.log(this.lastNote);
        } else {
          this.logger.warn(`趋势策略平仓失败 lot=${lot.id}: ${r.error}`);
        }
      }
      return; // 持仓期间不开新仓
    }

    // ---- 2. 空仓：冷却期内不开 ----
    if (Date.now() - this.lastCloseAt < p.cooldownSec * 1000) {
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

    const strength = Math.abs(fast - slow) / slow;
    if (strength < p.minTrendStrength) {
      this.lastNote = `震荡（趋势强度 ${(strength * 100).toFixed(3)}% < ${(p.minTrendStrength * 100).toFixed(3)}%），不开仓`;
      return;
    }

    // 顺势：快线在上方做多，在下方做空
    const dir = fast > slow ? 'LONG' : 'SHORT';
    const r = await exec.openLot({
      direction: dir,
      quantity: p.baseQty,
      leverage: p.leverage,
      reason: 'trend-entry',
    });
    if (r.error) {
      this.lastNote = `开仓失败：${r.error}`;
      this.logger.warn(this.lastNote);
      return;
    }
    this.lastNote = `顺势开 ${dir} × ${p.baseQty}（${p.leverage}x，趋势强度 ${(strength * 100).toFixed(3)}%）`;
    this.logger.log(this.lastNote);
  }

  /**
   * 单笔出场判定：收益率达到止盈或跌破止损即平。
   *
   * 用 `unrealizedPnl / 开仓名义` 作为收益率——
   * 分子已含开仓手续费，与马丁的篮子口径一致（都扣了成本）。
   */
  private checkExit(
    lot: {
      direction: 'LONG' | 'SHORT';
      quantity: number;
      entryPrice: number;
      unrealizedPnl: number;
    },
    p: { takeProfitPct: number; stopLossPct: number },
  ): { shouldClose: boolean; reason: 'TAKE_PROFIT' | 'STOP_LOSS' } {
    const notional = lot.entryPrice * lot.quantity;
    if (!(notional > 0)) return { shouldClose: false, reason: 'STOP_LOSS' };
    const pnlPct = lot.unrealizedPnl / notional;

    if (pnlPct >= p.takeProfitPct) return { shouldClose: true, reason: 'TAKE_PROFIT' };
    if (pnlPct <= -p.stopLossPct) return { shouldClose: true, reason: 'STOP_LOSS' };
    return { shouldClose: false, reason: 'STOP_LOSS' };
  }
}
