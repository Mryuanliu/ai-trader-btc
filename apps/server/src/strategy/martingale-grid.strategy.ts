import { Injectable, Logger } from '@nestjs/common';
import { atr, ema } from '@ai-trader/shared';
import type { Candle, LotDirection } from '@ai-trader/shared';
import type {
  StrategyContext,
  StrategyExecutor,
  StrategyLotView,
  StrategyOrderView,
  TradingStrategy,
} from './types';

/** 参数 JSON Schema（前端据此渲染配置表单） */
const PARAM_SCHEMA = {
  type: 'object',
  properties: {
    baseQty: { type: 'number', title: '首层数量(BTC)', minimum: 0.0001 },
    lotMultiplier: { type: 'number', title: '马丁倍率', minimum: 1, maximum: 3 },
    maxLayersPerSide: { type: 'integer', title: '每侧最大层数', minimum: 1, maximum: 12 },
    firstStepAtrMult: { type: 'number', title: '首单距离(×ATR)', minimum: 0.1 },
    stepAtrMult: { type: 'number', title: '网格间距(×ATR)', minimum: 0.1 },
    minStepPct: { type: 'number', title: '间距下限(比例,成本地板)', minimum: 0.0001 },
    maxStepPct: { type: 'number', title: '间距上限(比例)', minimum: 0.001 },
    enabledSides: { type: 'string', title: '交易方向', enum: ['both', 'longOnly', 'shortOnly'] },
    useTrendFilter: { type: 'boolean', title: '单侧金字塔过滤(EA语义)' },
    trendMaPeriod: { type: 'integer', title: '趋势均线周期', minimum: 5 },
    leverage: { type: 'integer', title: '杠杆', minimum: 1, maximum: 20 },
    pendingMode: { type: 'boolean', title: '挂单模式(STOP单)' },
    basketStartPct: { type: 'number', title: '篮子追踪止盈启动(比例)', minimum: 0 },
    basketGivebackPct: { type: 'number', title: '篮子追踪回撤(比例)', minimum: 0 },
    basketStopLossPct: { type: 'number', title: '篮子止损(比例,0=关)', minimum: 0 },
    netExposureCapPct: { type: 'number', title: '净敞口上限(名义/保证金,0=不限)', minimum: 0 },
  },
} as const;

const DEFAULT_PARAMS: Record<string, unknown> = {
  baseQty: 0.001,
  lotMultiplier: 1.5,
  maxLayersPerSide: 6,
  firstStepAtrMult: 1.0,
  stepAtrMult: 1.0,
  // 间距下限 = 成本地板：币安合约 taker 往返约 0.1%，间距须远高于它
  // 才不至于「每层手续费吃掉全部利润」。0.3% ≈ 成本 × 3 ≈ BTC 1m ATR14。
  minStepPct: 0.003,
  // 上限收紧到 1.5%：ATR 飙升时不让间距失控（主流现货 1.5%~3% ÷ 10 倍杠杆）
  maxStepPct: 0.015,
  enabledSides: 'both',
  useTrendFilter: true,
  trendMaPeriod: 30,
  leverage: 10,
  pendingMode: true,
  basketStartPct: 0.015,
  basketGivebackPct: 0.005,
  basketStopLossPct: 0,
  netExposureCapPct: 0,
};

/** 平仓手续费率估算（taker），用于把浮盈折算成「净」值参与篮子判定 */
const EXIT_FEE_RATE = 0.0005;

/**
 * 马丁网格策略（移植自黄金 EA `king-v4-balance.mq5`）。
 *
 * 与 EA 对齐的核心语义：
 * 1. **挂单式网格**：所有入场都是 STOP 触发单（BUY 挂上方突破买 / SELL 挂下方破位卖），
 *    不在 tick 里直接市价开仓——触发时机交给交易所，避免我们轮询迟到。
 * 2. **首层无条件**：无持仓即挂第一层（距现价 `firstStepAtrMult × ATR`）。
 * 3. **加层等回归确认**：EA 的加层不是「跌了就摊平」，而是
 *    「价格相对最不利持仓再走远 2 个网格」后，才在现价外侧挂突破单，
 *    等价格回头确认再进——过滤掉单边趋势里的盲目加仓。
 * 4. **单侧金字塔**：默认只在一侧持仓（`hold positions on at most ONE side`），
 *    另一侧的挂单会被撤掉；决定了做哪边后不再两头挂。
 * 5. **篮子追踪止盈**：不设逐层止盈，只看整篮子净收益（扣平仓成本）——
 *    达到启动阈值后跟踪峰值，回撤 `basketGivebackPct` 即全平了结。
 *
 * 平台侧不参与以上任何判断：策略自治，平台只负责把单子送到交易所。
 */
@Injectable()
export class MartingaleGridStrategy implements TradingStrategy {
  private readonly logger = new Logger(MartingaleGridStrategy.name);

  readonly name = 'martingale_grid';
  readonly label = '马丁网格';
  readonly description =
    '双向 STOP 挂单网格 + 马丁倍率加层 + 单侧金字塔过滤 + 篮子追踪止盈（移植自黄金 EA）';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;

  /** 篮子净收益率的峰值（追踪止盈用）；篮子清空后重置 */
  private basketPeakPct = 0;
  /** 最近一次 tick 的决策摘要，供前端展示 */
  private lastNote = '';

  /**
   * 可观测快照：纯派生数据，不参与任何决策。
   *
   * 用户看到「只下了一单就不动了」时，需要能回答「它在等什么」——
   * 是等价格走到加层线，还是等净收益触及止盈启动线。
   * 没有这些数字，正常的等待与真的卡死无法区分。
   */
  private lastObs: {
    price: number;
    step: number;
    longLayers: number;
    shortLayers: number;
    pendingLong: number;
    pendingShort: number;
    netPct: number;
    nextAddLong: number | null;
    nextAddShort: number | null;
    maxLayers: number;
    leverage: number;
    basketStartPct: number;
    basketGivebackPct: number;
    ladder: {
      long: Array<{ layer: number; price: number; qty: number }>;
      short: Array<{ layer: number; price: number; qty: number }>;
    };
  } | null = null;

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    const src = raw ?? {};
    const num = (key: string, min: number, max: number): number => {
      const v = Number(src[key]);
      if (!Number.isFinite(v)) return DEFAULT_PARAMS[key] as number;
      return Math.min(max, Math.max(min, v));
    };
    const bool = (key: string): boolean =>
      src[key] === undefined ? (DEFAULT_PARAMS[key] as boolean) : src[key] === true;
    const sides = String(src.enabledSides ?? DEFAULT_PARAMS.enabledSides);
    return {
      baseQty: num('baseQty', 0.00001, 1000),
      lotMultiplier: num('lotMultiplier', 1, 3),
      maxLayersPerSide: Math.floor(num('maxLayersPerSide', 1, 12)),
      firstStepAtrMult: num('firstStepAtrMult', 0.05, 20),
      stepAtrMult: num('stepAtrMult', 0.05, 20),
      minStepPct: num('minStepPct', 0.0001, 0.2),
      maxStepPct: num('maxStepPct', 0.001, 0.5),
      enabledSides: ['both', 'longOnly', 'shortOnly'].includes(sides) ? sides : 'both',
      useTrendFilter: bool('useTrendFilter'),
      trendMaPeriod: Math.floor(num('trendMaPeriod', 5, 500)),
      leverage: Math.floor(num('leverage', 1, 20)),
      pendingMode: bool('pendingMode'),
      basketStartPct: num('basketStartPct', 0, 1),
      basketGivebackPct: num('basketGivebackPct', 0, 1),
      basketStopLossPct: num('basketStopLossPct', 0, 1),
      netExposureCapPct: num('netExposureCapPct', 0, 100),
    };
  }

  onStart(params: Record<string, unknown>): void {
    this.basketPeakPct = 0;
    this.lastNote = `已启动（每侧最多 ${params.maxLayersPerSide} 层，倍率 ${params.lotMultiplier}）`;
  }

  onStop(): void {
    this.basketPeakPct = 0;
    this.lastNote = '';
  }

  getState(): Record<string, unknown> {
    const o = this.lastObs;
    return {
      basketPeakPct: this.basketPeakPct,
      note: this.lastNote,
      // 可观测信息：回答「为什么现在不动」
      ...(o
        ? {
            price: o.price,
            step: o.step,
            netPct: o.netPct,
            leverage: o.leverage,
            layers: { long: o.longLayers, short: o.shortLayers },
            pending: { long: o.pendingLong, short: o.pendingShort },
            nextAdd: { long: o.nextAddLong, short: o.nextAddShort },
            maxLayers: o.maxLayers,
            basketStartPct: o.basketStartPct,
            basketGivebackPct: o.basketGivebackPct,
            ladder: o.ladder,
          }
        : {}),
    };
  }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const lots = ctx.openLots;

    // 篮子为空：重置追踪峰值（新周期）
    if (lots.length === 0) this.basketPeakPct = 0;

    // ---- 1. 篮子出场（唯一出场途径）----
    if (lots.length > 0 && (await this.checkBasketExit(ctx, exec))) return;

    // ---- 2. 方向选择（单侧金字塔过滤）----
    const { allowLong, allowShort } = this.resolveSides(ctx);

    // ---- 3. 网格挂单 ----
    await this.ensureGrid(ctx, exec, allowLong, allowShort);

    // ---- 4. 记录可观测快照（只读，供前端展示「在等什么」）----
    this.recordObservability(ctx);
  }

  /**
   * 记录可观测快照。
   *
   * 纯派生数据，只用于前端回答「策略现在在等什么」——
   * 用户看到「只下了一单就不动了」时，需要知道是在等加层价还是等止盈线，
   * 而不是以为策略卡死了。
   */
  /**
   * 阶梯预览。
   *
   * 逐格推进每次只挂一层，用户看不到整条阶梯的空间布局，
   * 于是「间距是不是太宽」只能靠猜。这里按当前状态把 1~N 层的触发价
   * 全部推演出来（纯计算，不产生任何挂单），让阶梯在页面上可见。
   */
  private buildLadder(
    lots: StrategyLotView[],
    dir: LotDirection,
    ctx: StrategyContext,
    step: number,
  ): Array<{ layer: number; price: number; qty: number }> {
    const p = ctx.params as {
      baseQty: number;
      lotMultiplier: number;
      maxLayersPerSide: number;
      firstStepAtrMult: number;
    };
    // 多头越跌越买（阶梯向下），空头越涨越卖（阶梯向上）
    const down = dir === 'LONG';
    const firstStep = Math.max(step, this.atrOf(ctx.candles) * p.firstStepAtrMult);
    const filled = lots.length;
    const worst =
      filled > 0
        ? down
          ? Math.min(...lots.map((l) => l.entryPrice))
          : Math.max(...lots.map((l) => l.entryPrice))
        : 0;

    const rows: Array<{ layer: number; price: number; qty: number }> = [];
    for (let k = 1; k <= p.maxLayersPerSide; k++) {
      // 无持仓时首层距现价 firstStep，往后每层再远 1 个网格；
      // 已有持仓时从最不利持仓价继续向外按 1 个网格延伸。
      const price =
        filled === 0
          ? down
            ? ctx.price + firstStep - (k - 1) * step
            : ctx.price - firstStep + (k - 1) * step
          : down
            ? worst - (k - filled) * step
            : worst + (k - filled) * step;
      rows.push({
        layer: k,
        price,
        qty: Number((p.baseQty * Math.pow(p.lotMultiplier, k - 1)).toFixed(8)),
      });
    }
    return rows;
  }

  private recordObservability(ctx: StrategyContext): void {
    const p = ctx.params as {
      maxLayersPerSide: number;
      leverage: number;
      basketStartPct: number;
      basketGivebackPct: number;
    };
    const longs = ctx.openLots.filter((l) => l.direction === 'LONG');
    const shorts = ctx.openLots.filter((l) => l.direction === 'SHORT');
    const pendingLong = ctx.openOrders.filter((o) => o.side === 'BUY').length;
    const pendingShort = ctx.openOrders.filter((o) => o.side === 'SELL').length;

    // 与 checkBasketExit 同口径：净收益率已扣预估平仓手续费
    const netNotional = ctx.openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
    const netPct =
      netNotional > 0
        ? (ctx.openLots.reduce((a, l) => a + l.unrealizedPnl, 0) - netNotional * EXIT_FEE_RATE) /
          netNotional
        : 0;

    const step = this.gridStep(ctx);
    const nextAddFor = (lots: StrategyLotView[], dir: LotDirection): number | null => {
      if (lots.length === 0) return null;
      const worst =
        dir === 'LONG'
          ? Math.min(...lots.map((l) => l.entryPrice))
          : Math.max(...lots.map((l) => l.entryPrice));
      // 与 ensureSide 的 goneFar 判定保持一致（1 个网格）
      return dir === 'LONG' ? worst - step : worst + step;
    };

    this.lastObs = {
      price: ctx.price,
      step,
      longLayers: longs.length,
      shortLayers: shorts.length,
      pendingLong,
      pendingShort,
      netPct,
      nextAddLong: nextAddFor(longs, 'LONG'),
      nextAddShort: nextAddFor(shorts, 'SHORT'),
      maxLayers: p.maxLayersPerSide,
      leverage: p.leverage,
      basketStartPct: p.basketStartPct,
      basketGivebackPct: p.basketGivebackPct,
      ladder: {
        long: this.buildLadder(longs, 'LONG', ctx, step),
        short: this.buildLadder(shorts, 'SHORT', ctx, step),
      },
    };
  }

  // ---------------------------------------------------------------- 出场

  /**
   * 篮子追踪止盈 + 篮子止损。
   *
   * 口径：净收益率 = (Σ 浮动盈亏 − 预估平仓手续费) / Σ 开仓名义。
   * 触及止损，或「曾达到启动阈值且回撤超过 giveback」即全平所有仓位单。
   */
  private async checkBasketExit(ctx: StrategyContext, exec: StrategyExecutor): Promise<boolean> {
    const p = ctx.params as { basketStartPct: number; basketGivebackPct: number; basketStopLossPct: number };
    const netNotional = ctx.openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
    if (!(netNotional > 0)) return false;

    const gross = ctx.openLots.reduce((a, l) => a + l.unrealizedPnl, 0);
    const exitFee = netNotional * EXIT_FEE_RATE;
    const netPct = (gross - exitFee) / netNotional;

    if (netPct > this.basketPeakPct) this.basketPeakPct = netPct;

    let reason: 'TAKE_PROFIT' | 'STOP_LOSS' | null = null;
    if (p.basketStopLossPct > 0 && netPct <= -p.basketStopLossPct) {
      reason = 'STOP_LOSS';
    } else if (
      p.basketStartPct > 0 &&
      this.basketPeakPct >= p.basketStartPct &&
      this.basketPeakPct - netPct >= p.basketGivebackPct
    ) {
      reason = 'TAKE_PROFIT';
    }

    if (!reason) {
      this.lastNote = `篮子净收益 ${(netPct * 100).toFixed(2)}%（峰值 ${(this.basketPeakPct * 100).toFixed(2)}%）`;
      return false;
    }

    // 出场已在进行中（平仓单在途）：本 tick 只等结果，不重复下单也不挂新单。
    // 缺这道闸会让同一个 Lot 被平两次——第二次在已无仓位时就成了反向开仓。
    const inflight = ctx.openLots.filter((l) => l.hasPendingClose).length;
    if (inflight > 0) {
      this.lastNote = `篮子出场进行中（${inflight}/${ctx.openLots.length} 单在途），等待成交`;
      return true;
    }

    // 全平：先撤掉所有挂单，再逐 Lot 市价全平（Lot 模型禁止部分平仓）。
    // 撤单失败必须中止本轮出场——否则挂单可能在平仓的同时被触发建新仓。
    for (const order of ctx.openOrders) {
      const r = await exec.cancelOrder(order.id);
      if (!r.ok) {
        this.lastNote = `篮子出场中止：撤销挂单失败（${r.error}）`;
        this.logger.warn(this.lastNote);
        return true;
      }
    }
    for (const lot of ctx.openLots) {
      const r = await exec.closeLot(lot.id, reason);
      if (!r.ok) this.logger.warn(`篮子出场平仓失败 lot=${lot.id}: ${r.error}`);
    }
    this.basketPeakPct = 0;
    this.lastNote = `篮子${reason === 'TAKE_PROFIT' ? '止盈' : '止损'}：净收益 ${(netPct * 100).toFixed(2)}%，已全平 ${ctx.openLots.length} 单`;
    this.logger.log(this.lastNote);
    return true;
  }

  // ------------------------------------------------------------ 方向过滤

  /**
   * 单侧金字塔（EA `ApplyTrendGridFilter` 语义）：
   * - 已有买无卖 → 只允许买；已有卖无买 → 只允许卖
   * - 两边都有   → 保留层数多的一侧
   * - 都没有     → 由趋势评分决定（EMA 斜率 + 价格偏离）
   * 未启用过滤时按 enabledSides 双向放行。
   */
  private resolveSides(ctx: StrategyContext): { allowLong: boolean; allowShort: boolean } {
    const p = ctx.params as { enabledSides: string; useTrendFilter: boolean; trendMaPeriod: number };
    const sideLimit = p.enabledSides;
    const longOk = sideLimit !== 'shortOnly';
    const shortOk = sideLimit !== 'longOnly';

    const longLots = ctx.openLots.filter((l) => l.direction === 'LONG');
    const shortLots = ctx.openLots.filter((l) => l.direction === 'SHORT');

    if (!p.useTrendFilter) {
      return { allowLong: longOk, allowShort: shortOk };
    }

    if (longLots.length > 0 && shortLots.length === 0) {
      return { allowLong: longOk, allowShort: false };
    }
    if (shortLots.length > 0 && longLots.length === 0) {
      return { allowLong: false, allowShort: shortOk };
    }
    if (longLots.length > 0 && shortLots.length > 0) {
      // 两侧都有（快速掉头过渡期）：保留层数多的一侧，另一侧不再加仓
      const preferLong = longLots.length >= shortLots.length;
      return { allowLong: longOk && preferLong, allowShort: shortOk && !preferLong };
    }

    const score = this.trendScore(ctx.candles, p.trendMaPeriod);
    return { allowLong: longOk && score >= 0, allowShort: shortOk && score < 0 };
  }

  /**
   * 趋势评分 -1~1：EMA 斜率归一化 + 价格相对 EMA 的偏离（以 ATR 归一）。
   * EA 用多周期 market_score，这里用同源思想的轻量替代（平台不再提供决策内核）。
   */
  private trendScore(candles: Candle[], maPeriod: number): number {
    if (candles.length < maPeriod + 5) return 0;
    const closes = candles.map((c) => c.close);
    const maNow = ema(closes, maPeriod);
    const maPrev = ema(closes.slice(0, -5), maPeriod);
    const last = closes[closes.length - 1];
    const a = this.atrOf(candles);
    if (!Number.isFinite(maNow) || !Number.isFinite(maPrev) || !(a > 0)) return 0;

    const slope = (maNow - maPrev) / a; // 均线斜率（ATR 归一）
    const dev = (last - maNow) / a; // 价格偏离
    const raw = slope * 0.6 + dev * 0.4;
    return Math.max(-1, Math.min(1, Math.tanh(raw)));
  }

  // ------------------------------------------------------------ 网格挂单

  private async ensureGrid(
    ctx: StrategyContext,
    exec: StrategyExecutor,
    allowLong: boolean,
    allowShort: boolean,
  ): Promise<void> {
    const pendingBuy = ctx.openOrders.filter((o) => o.side === 'BUY');
    const pendingSell = ctx.openOrders.filter((o) => o.side === 'SELL');
    const longLots = ctx.openLots.filter((l) => l.direction === 'LONG');
    const shortLots = ctx.openLots.filter((l) => l.direction === 'SHORT');

    if (allowLong) await this.ensureSide('LONG', longLots, pendingBuy, ctx, exec);
    if (allowShort) await this.ensureSide('SHORT', shortLots, pendingSell, ctx, exec);
  }

  /**
   * 单侧网格：决定是否挂下一层，以及挂在哪里。
   *
   * EA 语义（`TryPlacePendingOrders`）：
   * - 该侧无持仓且无挂单 → 挂首层，距现价 `firstStep`
   * - 该侧已有持仓 → 只有当价格相对**最不利持仓**再走远 2 个网格时，
   *   才在现价外侧 `step` 处挂突破单（等回归确认，而非跌了就摊平）
   * - 该侧已有挂单 → 不重复挂（每次只保留一层待成交）
   */
  private async ensureSide(
    dir: LotDirection,
    lots: StrategyLotView[],
    pendings: StrategyOrderView[],
    ctx: StrategyContext,
    exec: StrategyExecutor,
  ): Promise<void> {
    const p = ctx.params as {
      baseQty: number;
      lotMultiplier: number;
      maxLayersPerSide: number;
      firstStepAtrMult: number;
      leverage: number;
    };
    const layers = lots.length + pendings.length;
    if (layers >= p.maxLayersPerSide) return;
    if (pendings.length > 0) return; // 已有待成交层，等它触发或撤销

    const step = this.gridStep(ctx);
    if (!(step > 0)) return;
    const firstStep = Math.max(step, this.atrOf(ctx.candles) * p.firstStepAtrMult);

    let stopPrice: number;
    if (lots.length === 0) {
      // 首层：无条件挂（EA: buy_positions == 0 即挂）
      stopPrice = dir === 'LONG' ? ctx.price + firstStep : ctx.price - firstStep;
    } else {
      const worst =
        dir === 'LONG'
          ? Math.min(...lots.map((l) => l.entryPrice))
          : Math.max(...lots.map((l) => l.entryPrice));
      // 加层触发：EA 原样是「现价相对最不利持仓走远 1 个网格」
      // （mq5: target_price <= buy_lowest_position - buy_step）。
      // 曾误写成 2 个网格，等于把加层线翻倍——6 层需要 3.6%+ 的价格区间才铺得开，
      // 实际表现就是「只下一单、再也不加层」。
      const goneFar = dir === 'LONG' ? ctx.price <= worst - step : ctx.price >= worst + step;
      if (!goneFar) return;
      // 在现价外侧一步处挂突破单：等价格回头确认再进
      stopPrice = dir === 'LONG' ? ctx.price + step : ctx.price - step;
    }

    if (!(stopPrice > 0)) return;

    // 手数 = 首层 × 倍率^已层数（EA: EffectiveBaseLot × pow(multiplier, positions)）
    const qty = Number(
      (p.baseQty * Math.pow(p.lotMultiplier, layers)).toFixed(8),
    );
    if (!(qty > 0)) return;

    const r = await exec.placeStopOrder({
      direction: dir,
      stopPrice,
      quantity: qty,
      // 策略自己声明杠杆，避免「参数写 5x、实际按配置 12x 下单」的不一致
      leverage: p.leverage,
      reason: `grid-${dir.toLowerCase()}-L${layers + 1}`,
    });
    if (r.orderId) {
      this.lastNote = `挂 ${dir} 第 ${layers + 1} 层 @ ${stopPrice.toFixed(2)} × ${qty}（${p.leverage}x）`;
      this.logger.log(this.lastNote);
    } else if (r.error) {
      this.lastNote = `挂 ${dir} 第 ${layers + 1} 层失败：${r.error}`;
      this.logger.warn(this.lastNote);
    }
  }

  /** 网格间距：ATR 驱动并钳制在 [minStepPct, maxStepPct] 之间 */
  private gridStep(ctx: StrategyContext): number {
    const p = ctx.params as { stepAtrMult: number; minStepPct: number; maxStepPct: number };
    const a = this.atrOf(ctx.candles);
    const byAtr = a > 0 ? a * p.stepAtrMult : 0;
    const min = ctx.price * p.minStepPct;
    const max = ctx.price * p.maxStepPct;
    const raw = byAtr > 0 ? byAtr : min;
    return Math.min(max, Math.max(min, raw));
  }

  private atrOf(candles: Candle[]): number {
    if (candles.length < 20) return 0;
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);
    const v = atr(highs, lows, closes, 14);
    return Number.isFinite(v) ? v : 0;
  }
}
