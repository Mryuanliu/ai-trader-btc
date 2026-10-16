import { Injectable, Logger } from '@nestjs/common';
import { atr, ema, FUTURES_TAKER_FEE_RATE } from '@ai-trader/shared';
import type { Candle, LotDirection } from '@ai-trader/shared';
import { MarketRegime } from './lib/market-regime';
import type { RegimeSnapshot } from './lib/market-regime';
import { directionalStep, scoreLotMultiplier, basketStartNow } from './lib/score-sizing';
import type { SizingCfg } from './lib/score-sizing';
import {
  sideExtremes,
  canAddLayer,
  rebalanceEligible,
  shouldTrail,
  applyTriggerFloor,
  marginPrecheck,
  nearFundingWindow,
} from './lib/pending-discipline';
import type { Side } from './lib/pending-discipline';
import {
  scoreDomain,
  sideTargetUsdt,
  trendProtectionMinRatio,
  priceRetraced,
  distanceRetraced,
  findReductionPair,
} from './lib/exit-chain';
import type { LotNetView, PairGuard } from './lib/exit-chain';
import { extremeGuardFlags } from './lib/extreme-guard';
import type { ExtremeGuardFlags } from './lib/extreme-guard';
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
    firstOrderMarket: { type: 'boolean', title: '首层市价开仓(不等突破)' },
    basketStartPct: { type: 'number', title: '篮子追踪止盈启动(比例)', minimum: 0 },
    basketGivebackPct: { type: 'number', title: '篮子追踪回撤(比例)', minimum: 0 },
    basketStopLossPct: { type: 'number', title: '篮子止损(比例,0=关)', minimum: 0 },
    basketTakeProfitUsdt: { type: 'number', title: '篮子固定止盈(USDT,0=关)', minimum: 0 },
    basketStopLossUsdt: { type: 'number', title: '篮子固定止损(USDT,0=关)', minimum: 0 },
    cooldownAfterStopSec: { type: 'integer', title: '止损后冷却(秒,0=关)', minimum: 0, maximum: 86400 },
    netExposureCapPct: { type: 'number', title: '净敞口上限(名义/保证金,0=不限)', minimum: 0 },
    triggerPriceType: { type: 'string', title: '止盈/止损判定基准', enum: ['mark', 'last'] },
    // ---- V2 机制开关（逐项接入，关断态 = 老策略 martingale_grid 逐位一致）----
    useBrain: { type: 'boolean', title: 'M1 Brain 六因子市场内核' },
    useScoreSizing: { type: 'boolean', title: 'M2 评分驱动间距/倍率/目标' },
    usePendingDiscipline: { type: 'boolean', title: 'M3 挂单纪律（2格回归/跟踪/预检）' },
    useExitChain: { type: 'boolean', title: 'M4 出场优先级链' },
    usePivotCarry: { type: 'boolean', title: 'M5 pivot 双侧 carry' },
    useExtremeGuard: { type: 'boolean', title: 'M6 极端行情熔断（yuanliu 增强）' },
    pauseAroundFunding: { type: 'boolean', title: 'funding 结算窗暂停开层' },
    // ---- V2 机制数值参数（EA 无量纲原样；开关开启后才被消费）----
    trendRange: { type: 'number', title: '震荡域上界|score|', minimum: 0, maximum: 100 },
    trendConfirm: { type: 'number', title: '确认域下界', minimum: 0, maximum: 100 },
    trendStrong: { type: 'number', title: '强趋势下界', minimum: 0, maximum: 100 },
    trendDirEnter: { type: 'number', title: '方向域进入门槛', minimum: 0, maximum: 100 },
    trendDirExit: { type: 'number', title: '方向域退出门槛', minimum: 0, maximum: 100 },
    chopGate: { type: 'number', title: '抖动门槛(chop)', minimum: 0, maximum: 1 },
    kStepTrend: { type: 'number', title: '顺势间距斜率(加密)', minimum: 0, maximum: 1 },
    kStepCounter: { type: 'number', title: '逆势间距斜率(拉宽)', minimum: 0, maximum: 1 },
    trendMultMin: { type: 'number', title: '趋势域倍率下限', minimum: 1, maximum: 3 },
    basketAmpK: { type: 'number', title: '篮子目标幅度系数', minimum: 0, maximum: 3 },
    sideTargetPct: { type: 'number', title: '分侧均值目标(名义比例)', minimum: 0 },
    firstTrailBars: { type: 'integer', title: '首单追踪窗口(根K线)', minimum: 1 },
    pendingTrailStepPct: { type: 'number', title: '挂单跟踪偏离地板(比例)', minimum: 0 },
    rebalanceRatio: { type: 'number', title: '再平衡失衡比', minimum: 1 },
    pivotLookback: { type: 'integer', title: 'pivot 动量回看(根K线)', minimum: 1 },
    pivotMomPct: { type: 'number', title: 'pivot 逆行阈值(比例)', minimum: 0 },
    pivotLossPct: { type: 'number', title: 'pivot 深浮亏阈值(权益比例)', minimum: 0 },
    atrSpikeMult: { type: 'number', title: 'ATR 尖峰倍数', minimum: 1 },
    volDirGate: { type: 'number', title: '量价方向门', minimum: 0, maximum: 1 },
    bodyAtrMult: { type: 'number', title: '大实体拦截(×ATR)', minimum: 0.5 },
    minTriggerDistPct: { type: 'number', title: '触发价距离地板(比例)', minimum: 0 },
    marginGuardFree: { type: 'number', title: '保证金预检-可用倍数', minimum: 1 },
    marginGuardEquity: { type: 'number', title: '保证金预检-权益倍数', minimum: 1 },
    pairMaxShare: { type: 'number', title: '配对减仓最大占比', minimum: 0, maximum: 1 },
  },
} as const;

const DEFAULT_PARAMS: Record<string, unknown> = {
  // 首层 0.01 BTC：测试阶段放大 10 倍，让每轮的盈亏与手续费占比都更接近
  // 真实交易量级（0.001 时手续费占比被放大，盈亏数字也小到看不出规律）
  baseQty: 0.01,
  // 回测台 walk-forward 调优（1h×360d，2026-10-01）：mult 1.5 虽抬升样本内收益，
  // 但 OOS 衰减、回撤超阀（多重比较陷阱）；mult=1 等权网格 OOS 稳健最优。
  lotMultiplier: 1.0,
  maxLayersPerSide: 4,
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
  /**
   * 首层是否用**市价立即开仓**（而不是挂 STOP 单等价格突破）。
   *
   * EA 原样是挂单等突破；但「等突破」意味着行情平静时可能很久不成交——
   * 测试/验证阶段看不到任何交易，就无法观察策略行为。
   * 开启后：启动即市价开首层，后续加层仍按网格挂单（忠于 EA 的加层语义）。
   * 想完全还原 EA 的话关掉它。
   */
  firstOrderMarket: true,
  // 止盈启动 1.5%：回测台证实这口网格的主要风险不是「止盈不够大」而是「止盈太慢→
  // 深套前无法恢复」。收紧到 1.5%（原 2.5%）让篮子更快落袋、回撤前复位，
  // 全样本最大回撤从 34% 降到 <7%（代价：单轮收益变小、更依赖频次）。
  basketStartPct: 0.015,
  // 回撤容忍同步放大：止盈目标变大，追踪的回撤空间也要跟着放宽，
  // 否则刚启动追踪就被一波正常回撤打掉，等于没放大止盈。
  basketGivebackPct: 0.008,
  basketStopLossPct: 0,
  // 篮子固定止盈/止损（USDT 绝对额，0=关）：净收益（已扣预估平仓费）直接达标即出场，
  // 不依赖比例/追踪——便于用「赚够 X U / 亏到 X U 就走」的直观口径观察整条交易链路。
  basketTakeProfitUsdt: 0,
  basketStopLossUsdt: 0,
  /**
   * 止损后冷却（秒，2026-10-16 新增，0=关；与 V1 同参数同语义）。
   * 切断震荡市「止损 → 反弹追入 → 再止损」的碎钞循环；止盈了结不触发。
   */
  cooldownAfterStopSec: 300,
  netExposureCapPct: 0,
  // 判定基准默认标记价（抗插针、与交易所风控同口径）；last=最新成交价（更跟手但可能被插针误触发）
  triggerPriceType: 'mark',
  // ---- V2 机制：全部默认关。关断态行为 = 老策略 martingale_grid 逐位一致（E0 回归基线）。
  // 每个开关对应一个闸门实验（E1-E6），单变量递进开启。----
  useBrain: false,
  useScoreSizing: false,
  usePendingDiscipline: false,
  useExitChain: false,
  usePivotCarry: false,
  useExtremeGuard: false,
  pauseAroundFunding: false,
  // ---- V2 机制数值参数（EA king-v4-balance 无量纲原样；点值类已按 §5 换算表折成比例/根数）----
  trendRange: 20,
  trendConfirm: 45,
  trendStrong: 70,
  trendDirEnter: 26,
  trendDirExit: 14,
  chopGate: 0.58,
  kStepTrend: 0.25,
  kStepCounter: 0.083,
  trendMultMin: 1.0,
  basketAmpK: 0.8,
  sideTargetPct: 0.006,
  firstTrailBars: 1,
  pendingTrailStepPct: 0.0005,
  rebalanceRatio: 3.0,
  pivotLookback: 3,
  pivotMomPct: 0.0025,
  pivotLossPct: 0.05,
  atrSpikeMult: 2.0,
  volDirGate: 0.3,
  bodyAtrMult: 2.0,
  minTriggerDistPct: 0.0005,
  marginGuardFree: 1.15,
  marginGuardEquity: 1.25,
  pairMaxShare: 0.3,
};

/** 平仓手续费率估算（taker），用于把浮盈折算成「净」值参与篮子判定；与结算/展示共用单一真值 */
const EXIT_FEE_RATE = FUTURES_TAKER_FEE_RATE;

/**
 * 马丁网格 V2（King 内核移植）。
 *
 * 目标：把黄金 EA `king-v4-balance.mq5` 的完整决策能力移植到平台引擎——
 * Brain 六因子市场内核（M1）、评分驱动间距/倍率/目标（M2）、挂单纪律（M3）、
 * 四层出场优先级链（M4）、pivot 双侧 carry（M5）、极端行情熔断（M6）。
 * 完整设计已内化为本文件与实现注释（原 `docs/martingale-grid-v2-king-port-plan.md` 已归档至 git 历史）。
 *
 * 与老策略 `martingale_grid` 的关系（骨架克隆，非同盘改写）：
 * - 老策略全部 20 参同名同语义继承，行为代码逐位一致；
 * - V2 新机制全部开关**默认关**，关断态 = 老策略（E0 diff=0 基线可对账）；
 * - 老策略原样保留作回滚锚；两策略可同标的 A/B（共享保证金，见方案 M8 注意事项）。
 *
 * 核心交易语义（与老策略一致的部分）：
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
  interface V2Obs {
    price: number;
    step: number;
    longLayers: number;
    shortLayers: number;
    pendingLong: number;
    pendingShort: number;
    netPct: number;
    netUsdt: number;
    /** 币安口径毛浮盈（不含任何手续费的纯价差浮盈，按判定基准价），供面板与交易所对账 */
    grossUsdt: number;
    /** 止盈/净收益实际所用的判定价（标记价或最新价，由 triggerPriceType 决定） */
    pnlPrice: number;
    /** 判定价基准：mark=标记价(抗插针) / last=最新成交价 */
    pnlPriceType: 'mark' | 'last';
    nextAddLong: number | null;
    nextAddShort: number | null;
    maxLayers: number;
    leverage: number;
    basketStartPct: number;
    basketGivebackPct: number;
    basketTakeProfitUsdt: number;
    basketStopLossUsdt: number;
    ladder: {
      long: Array<{ layer: number; price: number; qty: number }>;
      short: Array<{ layer: number; price: number; qty: number }>;
    };
  }

  interface V2PairCandidate {
    profitLotId: string;
    riskLotId: string;
    allowed: boolean;
    why: string;
  }

interface V2InstanceState {
  basketPeakPct: number;
  /** 已发过市价首层的执行周期 K 线时间戳（首层去重闸） */
  firstMarketBarTime: number;
  /** 最近一次篮子止损时间（冷却闸用；止盈了结不更新） */
  lastStopAt: number;
  basketArmed: boolean;
  firstTrailActive: boolean;
  firstTrailSide: Side | null;
  firstTrailPeakPrice: number;
  basketTrailActive: boolean;
  basketTrailPeakPrice: number;
  guardFlags: ExtremeGuardFlags | null;
  lastNote: string;
  pivotAlarm: boolean;
  marginBlocked: boolean;
  pairCandidate: V2PairCandidate | null;
  lastV2: Record<string, unknown> | null;
  regime: MarketRegime | null;
  regimeSnap: RegimeSnapshot | null;
  /** Brain 已重算到的最后一根已收盘 K 线时间戳（bar 门控） */
  regimeBarTime: number;
  lastObs: V2Obs | null;
}

/** 真权益：钱包余额 + 浮盈（walletBalance 缺失时退化为可用保证金口径） */
function trueEquity(ctx: StrategyContext): number {
  const upnl = ctx.openLots.reduce((a, l) => a + l.unrealizedPnl, 0);
  return ctx.walletBalance > 0 ? ctx.walletBalance + upnl : ctx.availableMargin + upnl;
}

@Injectable()
export class MartingaleGridV2Strategy implements TradingStrategy {
  private readonly logger = new Logger(MartingaleGridV2Strategy.name);

  readonly name = 'martingale_grid_v2';
  readonly label = '马丁网格V2 · King内核';
  readonly description =
    '六因子 Brain 市场内核 + 评分驱动间距/倍率/目标 + 挂单纪律 + 四层出场链（完整移植自黄金 EA king-v4-balance）';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;
  /**
   * Brain 三框架吃满需 70×15=1050 根执行周期 K 线（M1），加熔断/ATR 余量声明 1100；
   * 实盘/回测 runner 据此喂窗口，两端同源（C-1 parity）。数据不足时 MarketRegime
   * 自带「该框架 0 分进融合」（同 EA L1387），冷启动行为两环境一致。
   */
  readonly contextCandles = 1100;

  // 注：版本 / 能力声明 / 风险提示统一由 `strategies/martingale-grid-v2/manifest.json` 提供，
  // 改文案或上下架不必改代码、不必重新编译。两处都写会漂移，故此处不留。


  /**
   * 可观测快照：纯派生数据，不参与任何决策。
   *
   * 用户看到「只下了一单就不动了」时，需要能回答「它在等什么」——
   * 是等价格走到加层线，还是等净收益触及止盈启动线。
   * 没有这些数字，正常的等待与真的卡死无法区分。
   */

  /**
   * 每实例可变状态（2026-10-16 修复「多实例状态互串」）。
   *
   * 策略是 DI 单例：同一策略的多个实例（不同币种）共享同一个对象，
   * 可变状态放实例字段上时，一个实例的 tick 会抹掉另一个实例的状态——
   * 空仓实例每 tick 重置 basketPeakPct，直接让有仓实例的追踪止盈失效。
   * 所有可变状态按 `ctx.instanceId`（策略名:交易对）隔离。
   */
  private readonly states = new Map<string, V2InstanceState>();

  private stateOf(instanceId: string): V2InstanceState {
    let s = this.states.get(instanceId);
    if (!s) {
      s = {
        basketPeakPct: 0,
        firstMarketBarTime: 0,
        lastStopAt: 0,
        basketArmed: false,
        firstTrailActive: false,
        firstTrailSide: null,
        firstTrailPeakPrice: 0,
        basketTrailActive: false,
        basketTrailPeakPrice: 0,
        guardFlags: null,
        lastNote: '',
        pivotAlarm: false,
        marginBlocked: false,
        pairCandidate: null,
        lastV2: null,
        regime: null,
        regimeSnap: null,
        regimeBarTime: 0,
        lastObs: null,
      };
      this.states.set(instanceId, s);
    }
    return s;
  }

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
      firstOrderMarket: bool('firstOrderMarket'),
      basketStartPct: num('basketStartPct', 0, 1),
      basketGivebackPct: num('basketGivebackPct', 0, 1),
      basketStopLossPct: num('basketStopLossPct', 0, 1),
      basketTakeProfitUsdt: num('basketTakeProfitUsdt', 0, 1e9),
      basketStopLossUsdt: num('basketStopLossUsdt', 0, 1e9),
      cooldownAfterStopSec: Math.floor(num('cooldownAfterStopSec', 0, 86400)),
      netExposureCapPct: num('netExposureCapPct', 0, 100),
      triggerPriceType: ['mark', 'last'].includes(String(src.triggerPriceType ?? DEFAULT_PARAMS.triggerPriceType))
        ? String(src.triggerPriceType ?? DEFAULT_PARAMS.triggerPriceType)
        : 'mark',
      // ---- V2 机制开关与数值（clamp 到物理安全域；关断态下这些值不被读取）----
      useBrain: bool('useBrain'),
      useScoreSizing: bool('useScoreSizing'),
      usePendingDiscipline: bool('usePendingDiscipline'),
      useExitChain: bool('useExitChain'),
      usePivotCarry: bool('usePivotCarry'),
      useExtremeGuard: bool('useExtremeGuard'),
      pauseAroundFunding: bool('pauseAroundFunding'),
      // 钳制上限 99 + trendStrong 必须 > trendRange（2026-10-16 A13）：
      // 域值=100 会让 (100-x) 分母为 0 产生 NaN 间距/倍率（该侧静默停止挂单），
      // trendStrong≤trendRange 同样让 scoreLotMultiplier 除零。
      trendRange: num('trendRange', 0, 99),
      trendConfirm: num('trendConfirm', 0, 99),
      trendStrong: Math.max(num('trendStrong', 0, 99), num('trendRange', 0, 99) + 1),
      trendDirEnter: num('trendDirEnter', 0, 100),
      trendDirExit: num('trendDirExit', 0, 100),
      chopGate: num('chopGate', 0, 1),
      kStepTrend: num('kStepTrend', 0, 1),
      kStepCounter: num('kStepCounter', 0, 1),
      trendMultMin: num('trendMultMin', 1, 3),
      basketAmpK: num('basketAmpK', 0, 3),
      sideTargetPct: num('sideTargetPct', 0, 0.2),
      firstTrailBars: Math.floor(num('firstTrailBars', 1, 24)),
      pendingTrailStepPct: num('pendingTrailStepPct', 0, 0.05),
      rebalanceRatio: num('rebalanceRatio', 1, 20),
      pivotLookback: Math.floor(num('pivotLookback', 1, 288)),
      pivotMomPct: num('pivotMomPct', 0, 0.2),
      pivotLossPct: num('pivotLossPct', 0, 1),
      atrSpikeMult: num('atrSpikeMult', 1, 10),
      volDirGate: num('volDirGate', 0, 1),
      bodyAtrMult: num('bodyAtrMult', 0.5, 10),
      minTriggerDistPct: num('minTriggerDistPct', 0, 0.05),
      marginGuardFree: num('marginGuardFree', 1, 5),
      marginGuardEquity: num('marginGuardEquity', 1, 5),
      pairMaxShare: num('pairMaxShare', 0, 1),
    };
  }

  onStart(params: Record<string, unknown>, instanceId?: string): void {
    const id = instanceId ?? '';
    this.states.delete(id);
    const st = this.stateOf(id);
    st.lastNote = `已启动（每侧最多 ${params.maxLayersPerSide} 层，倍率 ${params.lotMultiplier}）`;
  }

  onStop(instanceId?: string): void {
    // 停实例即丢弃其全部运行态（Brain 自适应状态/追踪峰值/闸门一并清理）
    if (instanceId) this.states.delete(instanceId);
    else this.states.clear();
  }

  /**
   * Brain 刷新：每根执行周期 K 线重算一次三框架评分（EA 每 5s，粒度差见方案 §4）。
   * 四个消费开关任一开启就需要快照；全关时零开销（E0 关断态与老策略逐位一致）。
   */
  private refreshRegime(ctx: StrategyContext): void {
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as Record<string, unknown>;
    const need = Boolean(p.useBrain || p.useScoreSizing || p.useExitChain || p.usePivotCarry);
    if (!need) {
      st.regimeSnap = null;
      return;
    }
    if (!st.regime) {
      st.regime = new MarketRegime({
        tfMults: [1, 5, 15],
        frameWeights: [0.3, 0.36, 0.34],
        trendRange: p.trendRange as number,
        trendConfirm: p.trendConfirm as number,
        trendStrong: p.trendStrong as number,
        trendDirEnter: p.trendDirEnter as number,
        trendDirExit: p.trendDirExit as number,
        chopGate: p.chopGate as number,
        // 黄金 M1 标定常数：BTC 按等价分位重校准后才开 useBrain（E1 前置项，manifest 风险说明）
        calib: { slopeNorm: 0.06, macdNorm: 0.30, diNorm: 40 },
      });
    }
    // bar 门控 + 只用已收盘 K 线（2026-10-16 B3）：
    // 实盘 tick 800ms 一次，不设闸会把自适应平滑施加 ~75 次/bar（防抖被中和），
    // 且未收盘 bar 内容随价格跳动，与回测「每根 bar 一次、只用收盘数据」行为分叉。
    const closedBars = ctx.candles.length > 0 ? ctx.candles.slice(0, -1) : ctx.candles;
    const barT = closedBars.length > 0 ? closedBars[closedBars.length - 1].time : 0;
    if (barT > 0 && barT === st.regimeBarTime) return;
    if (barT > 0) st.regimeBarTime = barT;
    st.regimeSnap = st.regime.update(closedBars);
  }

  /** 三件套分段函数的共用配置（来自策略参数，clamp 已在 normalizeParams 完成） */
  private sizingCfg(params: Record<string, unknown>): SizingCfg {
    return {
      trendRange: params.trendRange as number,
      trendConfirm: params.trendConfirm as number,
      trendStrong: params.trendStrong as number,
      kStepTrend: params.kStepTrend as number,
      kStepCounter: params.kStepCounter as number,
      basketAmpK: params.basketAmpK as number,
    };
  }

  getState(instanceId?: string): Record<string, unknown> {
    // 无 instanceId 的调用（单实例场景/旧代码）：优先取有实际交易状态的条目，
    // 跳过 onStart 无参调用遗留的空键条目
    const st = instanceId
      ? this.states.get(instanceId)
      : ([...this.states.entries()].find(([k]) => k !== '')?.[1] ??
        [...this.states.values()][0]);
    const o = st?.lastObs ?? null;
    return {
      // 前端据此分流新策略展示（M8-①）；老策略无此字段走现有分支
      stateV: 2,
      basketPeakPct: st?.basketPeakPct ?? 0,
      note: st?.lastNote ?? '',
      // 可观测信息：回答「为什么现在不动」
      ...(o
        ? {
            price: o.price,
            step: o.step,
            netPct: o.netPct,
            netUsdt: o.netUsdt,
            grossUsdt: o.grossUsdt,
            pnlPrice: o.pnlPrice,
            pnlPriceType: o.pnlPriceType,
            leverage: o.leverage,
            layers: { long: o.longLayers, short: o.shortLayers },
            pending: { long: o.pendingLong, short: o.pendingShort },
            nextAdd: { long: o.nextAddLong, short: o.nextAddShort },
            maxLayers: o.maxLayers,
            basketStartPct: o.basketStartPct,
            basketGivebackPct: o.basketGivebackPct,
            basketTakeProfitUsdt: o.basketTakeProfitUsdt,
            basketStopLossUsdt: o.basketStopLossUsdt,
            ladder: o.ladder,
          }
        : {}),
      // stateV:2 三模块（regime/grid/exits）+ 暂停闸口；未跑过 tick 时缺失，前端降级显兜底字段
      ...(st?.lastV2 ?? {}),
    };
  }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const st = this.stateOf(ctx.instanceId);
    const lots = ctx.openLots;

    // stateV:2 观察标志每 tick 复位（纯展示，不参与任何决策）
    st.pivotAlarm = false;
    st.pairCandidate = null;
    st.marginBlocked = false;

    // ---- 0. Brain 市场内核（开关全关时零开销，行为与老策略一致）----
    this.refreshRegime(ctx);

    // 篮子为空：重置追踪峰值与出场链状态（新周期）
    if (lots.length === 0) {
      st.basketPeakPct = 0;
      st.basketArmed = false;
      st.firstTrailActive = false;
      st.firstTrailSide = null;
      st.firstTrailPeakPrice = 0;
      st.basketTrailActive = false;
      st.basketTrailPeakPrice = 0;
    }

    // M6 三层熔断：每 tick 评估一次（只拦新开/加层，不动出场）
    const pAll = ctx.params as Record<string, unknown>;
    st.guardFlags = pAll.useExtremeGuard
      ? extremeGuardFlags(ctx.candles, {
          atrSpikeMult: pAll.atrSpikeMult as number,
          volDirGate: pAll.volDirGate as number,
          bodyAtrMult: pAll.bodyAtrMult as number,
        })
      : null;

    // ---- 1. 出场：M4 优先级链（开启态）→ 篮子追踪/固定止损止盈兜底 ----
    if (lots.length > 0) {
      const chainOn = pAll.useExitChain === true && st.regimeSnap !== null;
      // 开启态接管也要留下新鲜快照（否则前端停在动作前的旧数据）；关断态不补记，
      // 保持与老策略 getState 逐位一致（E0 行为级钉）
      if (chainOn && (await this.runExitChain(ctx, exec))) {
        this.recordObservability(ctx);
        return;
      }
      if (await this.checkBasketExit(ctx, exec, chainOn)) {
        if (chainOn) this.recordObservability(ctx);
        return;
      }
    }

    // ---- 1.5 armed 态维持空挂单（M3-7，EA G12；纪律态专属）----
    // 追踪止盈 arm 后不再铺新层——防摊薄利润、改变峰值结构；残单一律撤掉。
    if (
      lots.length > 0 &&
      (ctx.params as Record<string, unknown>).usePendingDiscipline === true &&
      st.basketArmed
    ) {
      for (const o of ctx.openOrders) {
        const r = await exec.cancelOrder(o.id);
        if (!r.ok) this.logger.warn(`armed 态撤单失败（${r.error}）`);
      }
      st.lastNote = `篮子追踪已 arm（峰值 ${(st.basketPeakPct * 100).toFixed(2)}%）：维持空挂单，不开新层`;
      this.recordObservability(ctx);
      return;
    }

    // ---- 2. 方向选择（单侧金字塔过滤）+ M6 熔断拦截进场侧 ----
    let { allowLong, allowShort } = this.resolveSides(ctx);
    if (st.guardFlags) {
      if (st.guardFlags.spike) {
        st.lastNote = `熔断：ATR 尖峰 ${st.guardFlags.atrRatio.toFixed(2)}× 暂停新开/加层（出场链不受影响）`;
        this.recordObservability(ctx);
        return;
      }
      allowLong = allowLong && !st.guardFlags.blockLong;
      allowShort = allowShort && !st.guardFlags.blockShort;
    }

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
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as {
      maxLayersPerSide: number;
      leverage: number;
      basketStartPct: number;
      basketGivebackPct: number;
      basketTakeProfitUsdt: number;
      basketStopLossUsdt: number;
      triggerPriceType?: string;
    };
    const longs = ctx.openLots.filter((l) => l.direction === 'LONG');
    const shorts = ctx.openLots.filter((l) => l.direction === 'SHORT');
    const pendingLong = ctx.openOrders.filter((o) => o.side === 'BUY').length;
    const pendingShort = ctx.openOrders.filter((o) => o.side === 'SELL').length;

    // 与 checkBasketExit 同口径：净收益已扣预估平仓手续费（USDT 绝对额与比例两口径同源）
    const netNotional = ctx.openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
    // 币安口径毛浮盈：unrealizedPnl 已扣了开仓费，加回去即得纯价差浮盈（不含任何费），
    // 与币安持仓页「盈亏(USDT)」同口径（按标记价）。
    const grossUsdt = ctx.openLots.reduce((a, l) => a + l.unrealizedPnl + (l.entryFeeUsdt ?? 0), 0);
    const netUsdt =
      netNotional > 0
        ? ctx.openLots.reduce((a, l) => a + l.unrealizedPnl, 0) - netNotional * EXIT_FEE_RATE
        : 0;
    const netPct = netNotional > 0 ? netUsdt / netNotional : 0;

    const step = this.gridStep(ctx);
    const stepL = this.gridStepFor(ctx, 'LONG');
    const stepS = this.gridStepFor(ctx, 'SHORT');
    const discOn = (ctx.params as Record<string, unknown>).usePendingDiscipline === true;
    const nextAddFor = (lots: StrategyLotView[], dir: LotDirection): number | null => {
      if (lots.length === 0) return null;
      const sideStep = dir === 'LONG' ? stepL : stepS;
      const worst =
        dir === 'LONG'
          ? Math.min(...lots.map((l) => l.entryPrice))
          : Math.max(...lots.map((l) => l.entryPrice));
      // 与 ensureSide 判定一致：关断=1 格（老近似），纪律开=逆行 2 格（G9）
      const back = discOn ? 2 : 1;
      return dir === 'LONG' ? worst - sideStep * back : worst + sideStep * back;
    };

    // 判定基准：默认标记价（抗插针），triggerPriceType=last 时用最新成交价
    const pnlPriceType: 'mark' | 'last' = p.triggerPriceType === 'last' ? 'last' : 'mark';
    const pnlPrice = pnlPriceType === 'last' ? ctx.price : ctx.markPrice > 0 ? ctx.markPrice : ctx.price;

    st.lastObs = {
      price: ctx.price,
      pnlPrice,
      pnlPriceType,
      step,
      longLayers: longs.length,
      shortLayers: shorts.length,
      pendingLong,
      pendingShort,
      netPct,
      netUsdt,
      grossUsdt,
      nextAddLong: nextAddFor(longs, 'LONG'),
      nextAddShort: nextAddFor(shorts, 'SHORT'),
      maxLayers: p.maxLayersPerSide,
      leverage: p.leverage,
      basketStartPct: p.basketStartPct,
      basketGivebackPct: p.basketGivebackPct,
      basketTakeProfitUsdt: p.basketTakeProfitUsdt,
      basketStopLossUsdt: p.basketStopLossUsdt,
      ladder: {
        long: this.buildLadder(longs, 'LONG', ctx, stepL),
        short: this.buildLadder(shorts, 'SHORT', ctx, stepS),
      },
    };

    // ---- stateV:2 三模块快照（M8-① 数据契约；纯派生数据，零决策影响）----
    const pp = ctx.params as Record<string, unknown>;
    const snap = st.regimeSnap;
    const trendRangeN = pp.trendRange as number;
    const r2 = (v: number, d = 2): number => Number(v.toFixed(d));

    const sideView = (dir: 'LONG' | 'SHORT') => {
      const ls = dir === 'LONG' ? longs : shorts;
      const opp = dir === 'LONG' ? shorts : longs;
      const orders = ctx.openOrders.filter((o) => (o.side === 'BUY') === (dir === 'LONG'));
      const notional = ls.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
      const sideNet = ls.length > 0 ? ls.reduce((a, l) => a + l.unrealizedPnl, 0) - notional * EXIT_FEE_RATE : 0;
      // 实际生效间距/倍率（评分驱动后逐 tick 变化，不显示就是黑盒）
      const multNow =
        pp.useScoreSizing === true && snap
          ? scoreLotMultiplier(snap.score, pp.lotMultiplier as number, pp.trendMultMin as number, {
              trendRange: trendRangeN,
              trendStrong: pp.trendStrong as number,
            })
          : (pp.lotMultiplier as number);
      const targetUsdt =
        snap && pp.useExitChain === true && ls.length > 0
          ? sideTargetUsdt(notional, pp.sideTargetPct as number, snap.score, dir, trendRangeN)
          : null;
      // 挂单跟踪应挂价（M3-3）：纪律态专属，下一 tick 就会换单追过去才标 followTarget
      let followTarget: number | null = null;
      if (discOn && orders.length > 0) {
        const t = this.disciplineTarget(
          ctx,
          dir,
          ls,
          orders,
          opp,
          pp as unknown as { baseQty: number; firstStepAtrMult: number; rebalanceRatio: number; minTriggerDistPct: number },
        );
        if (t != null && shouldTrail(dir, orders[0].stopPrice, t, ctx.price * (pp.pendingTrailStepPct as number))) {
          followTarget = t;
        }
      }
      const ladderRows = st.lastObs?.ladder[dir === 'LONG' ? 'long' : 'short'] ?? [];
      return {
        layers: ls.length,
        lots: Number(ls.reduce((a, l) => a + l.quantity, 0).toFixed(8)),
        stepNow: r2(this.gridStepFor(ctx, dir)),
        multNow: Number(multNow.toFixed(4)),
        nextAddAt: nextAddFor(ls, dir),
        target: targetUsdt,
        sideNet: r2(sideNet),
        progressPct: targetUsdt != null && targetUsdt > 0 ? Number((sideNet / targetUsdt).toFixed(4)) : null,
        hit: targetUsdt != null && sideNet >= targetUsdt,
        pending: orders.map((o) => ({
          price: o.stopPrice,
          qty: o.quantity,
          ...(followTarget != null ? { followTarget } : {}),
        })),
        ladder: ladderRows.map((row) => ({ ...row, filled: row.layer <= ls.length })),
      };
    };
    const longView = sideView('LONG');
    const shortView = sideView('SHORT');

    st.lastV2 = {
      regime: snap
        ? {
            score: r2(snap.score),
            scoreRaw: r2(snap.scoreRaw),
            scoreTarget: r2(snap.scoreTarget),
            dir: snap.dir,
            state: snap.state,
            stateText: snap.stateText,
            chop: Number(snap.chop.toFixed(3)),
            coherence: Number(snap.coherence.toFixed(3)),
            conflict: Number(snap.conflict.toFixed(3)),
            strength: Number(snap.strength.toFixed(3)),
            frames: snap.frames.map((f) => ({
              mult: f.mult,
              score: r2(f.score, 1),
              trendiness: Number(f.trendiness.toFixed(3)),
              factors: f.factors,
            })),
            calibrated: st.regime?.cfg.calib ?? null,
          }
        : null,
      grid: {
        perSide: { long: longView, short: shortView },
        exposure: {
          netLots: Number((longView.lots - shortView.lots).toFixed(8)),
          grossNotional: r2(netNotional),
          marginOccupy: r2(p.leverage > 0 ? netNotional / p.leverage : 0),
          // 保守口径：两侧同帽，取更满一侧的剩余额度
          guardRemainLayers: Math.max(0, p.maxLayersPerSide - Math.max(longs.length, shorts.length)),
          pivotAlarm: st.pivotAlarm,
        },
      },
      exits: {
        basket: {
          netUsdt: r2(netUsdt),
          netPct: Number(netPct.toFixed(6)),
          peakPct: Number(st.basketPeakPct.toFixed(6)),
          startNow: Number(
            (pp.useScoreSizing === true && snap
              ? basketStartNow(pp.basketStartPct as number, snap.score, {
                  trendRange: trendRangeN,
                  basketAmpK: pp.basketAmpK as number,
                })
              : (pp.basketStartPct as number)
            ).toFixed(6),
          ),
          trailArmed: st.basketTrailActive,
          retraceExitAt: st.basketTrailActive
            ? r2(
                ctx.netQty >= 0
                  ? st.basketTrailPeakPrice * (1 - (pp.basketGivebackPct as number))
                  : st.basketTrailPeakPrice * (1 + (pp.basketGivebackPct as number)),
              )
            : null,
        },
        side: {
          long: { targetUsdt: longView.target, hit: longView.hit },
          short: { targetUsdt: shortView.target, hit: shortView.hit },
        },
        pair: { candidate: st.pairCandidate },
        firstTrail: {
          active: st.firstTrailActive,
          windowRemainBars: (() => {
            if (ctx.openLots.length !== 1) return null;
            const openedMs = Date.parse(ctx.openLots[0].openedAt);
            const bm = this.barMs(ctx);
            if (!Number.isFinite(openedMs)) return null;
            return Math.max(0, Math.ceil((openedMs + (pp.firstTrailBars as number) * bm - ctx.now) / bm));
          })(),
        },
      },
      // 暂停闸口（状态带徽章源）：哪个闸在拦新开/加层
      gates: {
        spike: st.guardFlags?.spike === true,
        funding: pp.pauseAroundFunding === true && nearFundingWindow(ctx.now),
        margin: st.marginBlocked,
        atrRatio: st.guardFlags ? Number(st.guardFlags.atrRatio.toFixed(2)) : null,
      },
    };
  }

  // ---------------------------------------------------------------- 出场

  /** 出场判定基准价：triggerPriceType=last → 最新成交价；否则标记价（取不到退化为 last） */
  private pnlPriceOf(ctx: StrategyContext): number {
    const pt = (ctx.params as Record<string, unknown>).triggerPriceType;
    return pt === 'last' ? ctx.price : ctx.markPrice > 0 ? ctx.markPrice : ctx.price;
  }

  /** 执行周期一根 K 线的毫秒数（末两根 time 差）；数据不足回退 60s */
  private barMs(ctx: StrategyContext): number {
    const cs = ctx.candles;
    if (cs.length >= 2) {
      const d = cs[cs.length - 1].time - cs[cs.length - 2].time;
      if (d > 0) return d;
    }
    return 60_000;
  }

  /**
   * M4 出场优先级链（EA TryAutoCloseLogic L3405–3428 的短路顺序）：
   *   1) 首单追踪（G7 L3122–3180）——单子持仓 + 开仓在 firstTrailBars 根窗口内 +
   *      净益 ≥ 1 格金额即 arm，判定价自峰值回撤 1 格平；
   *   2) 篮子追踪双口径（G14 L3056–3115）——钱达标 arm 后**独占**监控：只更新
   *      判定价峰值并等待撤离（priceRetraced·giveback），期间不加层不平仓；
   *   3) 分侧均值目标 + 域分流（G5 L3282–3378）——range 侧达标直平；neutral
   *      「hit 且对侧空直平否则配对」；trend 逆势侧达标快跑、顺势侧达标配对
   *      带趋势保护（G6）；
   *   4) 篮子 arm 尝试——净益 ≥ 名义×启动线 + 1 格金额（EA trigger_money 语义）
   *      即进 G14 追踪态并撤全部挂单（M3-7 联动）。
   * 点值→K 线口径换算见 lib/exit-chain 头注。返回 true = 本 tick 出场链已接管。
   */
  private async runExitChain(ctx: StrategyContext, exec: StrategyExecutor): Promise<boolean> {
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as Record<string, unknown>;
    const firstTrailBars = p.firstTrailBars as number;
    const basketStartPct = p.basketStartPct as number;
    const basketGivebackPct = p.basketGivebackPct as number;
    const sideTargetPct = p.sideTargetPct as number;
    const trendRange = p.trendRange as number;
    const trendConfirm = p.trendConfirm as number;
    const pairMaxShare = p.pairMaxShare as number;
    const basketAmpK = p.basketAmpK as number;

    const lots = ctx.openLots;
    const netNotional = lots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
    if (!(netNotional > 0)) return false;
    const netUsdt = lots.reduce((a, l) => a + l.unrealizedPnl, 0) - netNotional * EXIT_FEE_RATE;
    const netPct = netUsdt / netNotional;
    if (netPct > st.basketPeakPct) st.basketPeakPct = netPct;

    // 出场在途：等结算结果，不重复动作（同篮子兜底语义）
    const inflight = lots.filter((l) => l.hasPendingClose).length;
    if (inflight > 0) {
      st.lastNote = `出场链进行中（${inflight}/${lots.length} 单在途），等待成交`;
      return true;
    }

    const pnlPrice = this.pnlPriceOf(ctx);
    const netOf = (l: StrategyLotView): number =>
      l.unrealizedPnl - l.entryPrice * l.quantity * EXIT_FEE_RATE;
    const adverseOf = (l: StrategyLotView): number =>
      l.direction === 'LONG' ? Math.max(0, l.entryPrice - pnlPrice) : Math.max(0, pnlPrice - l.entryPrice);
    const toView = (l: StrategyLotView): LotNetView => ({
      id: l.id,
      direction: l.direction === 'SHORT' ? 'SHORT' : 'LONG',
      quantity: l.quantity,
      netUsdt: netOf(l),
      adverseDist: adverseOf(l),
    });

    // ---- 1) 首单追踪（G7）：仅单子持仓且开仓在窗口内----
    if (lots.length === 1) {
      const lot = lots[0];
      const side: Side = lot.direction === 'SHORT' ? 'SHORT' : 'LONG';
      const openedMs = Date.parse(lot.openedAt);
      const inWindow = Number.isFinite(openedMs) && ctx.now - openedMs <= firstTrailBars * this.barMs(ctx);
      if (st.firstTrailActive && st.firstTrailSide !== side) {
        st.firstTrailActive = false; // 方向变了（旧单平后新单反向）：重置重开窗口
        st.firstTrailPeakPrice = 0;
      }
      st.firstTrailSide = side;
      const step = this.gridStepFor(ctx, lot.direction);
      if (!st.firstTrailActive) {
        if (inWindow && netUsdt >= step * lot.quantity) {
          st.firstTrailActive = true;
          st.firstTrailPeakPrice = pnlPrice;
          for (const o of ctx.openOrders) await exec.cancelOrder(o.id); // arm 即撤挂单
          st.lastNote = `首单追踪 arm @ ${pnlPrice.toFixed(2)}（净 ${netUsdt.toFixed(2)}U ≥ 1格 ${step.toFixed(2)}×${lot.quantity}）`;
          return true;
        }
      } else {
        // 峰值按方向取极值（2026-10-16 A2）：LONG 跟最高价、SHORT 跟最低价。
        // 原来只往高推——空单盈利方向（跌）永远更新不了峰，追踪止盈退化成极高止损位
        const dirSign: 1 | -1 = side === 'LONG' ? 1 : -1;
        if (
          (dirSign > 0 && pnlPrice > st.firstTrailPeakPrice) ||
          (dirSign < 0 && pnlPrice < st.firstTrailPeakPrice)
        ) {
          st.firstTrailPeakPrice = pnlPrice;
        }
        for (const o of ctx.openOrders) await exec.cancelOrder(o.id);
        if (distanceRetraced(dirSign, st.firstTrailPeakPrice, pnlPrice, step)) {
          const peak = st.firstTrailPeakPrice;
          const r = await exec.closeLot(lot.id, 'TAKE_PROFIT');
          st.firstTrailActive = false;
          st.firstTrailPeakPrice = 0;
          st.lastNote = r.ok
            ? `首单追踪离场：峰 ${peak.toFixed(2)} 回撤 1 格，净 ${netUsdt.toFixed(2)}U`
            : `首单追踪平仓失败：${r.error}`;
          return true;
        }
        st.lastNote = `首单追踪持有中（峰 ${st.firstTrailPeakPrice.toFixed(2)}，回撤 1 格离场）`;
        return true;
      }
    } else if (st.firstTrailActive) {
      st.firstTrailActive = false; // 加层后首单追踪让位（EA L3136 仅单子持仓语义）
      st.firstTrailPeakPrice = 0;
    }

    // ---- 2) 篮子追踪已 arm（G14）：独占监控，等待价格回撤离场----
    if (st.basketTrailActive) {
      const dirSign: 1 | -1 = ctx.netQty >= 0 ? 1 : -1;
      if ((dirSign > 0 && pnlPrice > st.basketTrailPeakPrice) || (dirSign < 0 && pnlPrice < st.basketTrailPeakPrice)) {
        st.basketTrailPeakPrice = pnlPrice;
      }
      for (const o of ctx.openOrders) await exec.cancelOrder(o.id); // arm 态维持空挂单
      if (priceRetraced(dirSign, st.basketTrailPeakPrice, pnlPrice, basketGivebackPct)) {
        const peak = st.basketTrailPeakPrice;
        for (const l of lots) {
          const r = await exec.closeLot(l.id, 'TAKE_PROFIT');
          if (!r.ok) this.logger.warn(`篮子追踪平仓失败 lot=${l.id}: ${r.error}`);
        }
        st.basketTrailActive = false;
        st.basketTrailPeakPrice = 0;
        st.basketPeakPct = 0;
        st.lastNote = `篮子追踪离场：判定价峰 ${peak.toFixed(2)} 回撤 ${(basketGivebackPct * 100).toFixed(2)}%，净 ${netUsdt.toFixed(2)}U 全平 ${lots.length} 单`;
        this.logger.log(st.lastNote);
        return true;
      }
      st.lastNote = `篮子追踪持有（arm 后独占：峰 ${st.basketTrailPeakPrice.toFixed(2)}，回撤 ${(basketGivebackPct * 100).toFixed(2)}% 离场）`;
      return true; // 短路：arm 态不再走侧目标/配对/再 arm
    }

    // ---- 3) 分侧均值目标 + 域分流（G5/G6）----
    const snap = st.regimeSnap!;
    const domain = scoreDomain(snap.score, snap.dir, trendRange);
    const longLots = lots.filter((l) => l.direction === 'LONG');
    const shortLots = lots.filter((l) => l.direction === 'SHORT');
    const netOfSide = (ls: StrategyLotView[]): number =>
      ls.reduce((a, l) => a + l.unrealizedPnl, 0) - ls.reduce((a, l) => a + l.entryPrice * l.quantity, 0) * EXIT_FEE_RATE;
    const trendSide: Side = snap.score > 0 ? 'LONG' : 'SHORT';

    const longPnl = longLots.length > 0 ? netOfSide(longLots) : 0;
    const shortPnl = shortLots.length > 0 ? netOfSide(shortLots) : 0;
    const longHit =
      longLots.length > 0 &&
      longPnl >= sideTargetUsdt(longLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0), sideTargetPct, snap.score, 'LONG', trendRange);
    const shortHit =
      shortLots.length > 0 &&
      shortPnl >= sideTargetUsdt(shortLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0), sideTargetPct, snap.score, 'SHORT', trendRange);

    // ---- 配对候选预览（M8 exits.pair）：复制链内配对判据但不交易——
    // 消除“为什么不平那对”的不可解释态；链真正动作时另走 tryPairReduction。
    {
      const profitSide: Side =
        domain === 'trend'
          ? trendSide
          : longHit
            ? 'LONG'
            : shortHit
              ? 'SHORT'
              : longPnl >= shortPnl
                ? 'LONG'
                : 'SHORT';
      const pLots = profitSide === 'LONG' ? longLots : shortLots;
      const rLots = profitSide === 'LONG' ? shortLots : longLots;
      if (pLots.length > 0 && rLots.length > 0) {
        const guard: PairGuard | null =
          domain === 'trend' && profitSide === trendSide
            ? {
                protectLotsQty: (trendSide === 'LONG' ? longLots : shortLots).reduce((a, l) => a + l.quantity, 0),
                riskLotsQty: (trendSide === 'LONG' ? shortLots : longLots).reduce((a, l) => a + l.quantity, 0),
                minRatio: trendProtectionMinRatio(Math.abs(snap.score), trendConfirm),
                maxShare: pairMaxShare,
              }
            : null;
        const profitViews = this.sideViews(ctx, pLots);
        const riskViews = this.sideViews(ctx, rLots);
        const pick = findReductionPair({ profitLots: profitViews, riskLots: riskViews, minNet: 0.01, guard });
        if (pick) {
          st.pairCandidate = {
            profitLotId: pick.profit.id,
            riskLotId: pick.risk.id,
            allowed: true,
            why: `配对净 +${pick.net.toFixed(2)}U，待侧均值目标触发即执行`,
          };
        } else {
          // 去掉防护再探一次：能配对 = 被趋势防护拦，把拒绝原因直白展示
          const unp = findReductionPair({ profitLots: profitViews, riskLots: riskViews, minNet: 0.01, guard: null });
          st.pairCandidate = unp
            ? { profitLotId: unp.profit.id, riskLotId: unp.risk.id, allowed: false, why: '趋势防护拦截（配对手数超占比帽或剩余敞口不达比例闸）' }
            : null;
        }
      }
    }

    if (domain === 'range') {
      // 震荡域：哪侧均值目标达标就平哪侧（EA L3293–3310：无配对保护）
      if (longHit && (await this.closeSideExit(ctx, exec, longLots, '多头侧'))) return true;
      if (shortHit && (await this.closeSideExit(ctx, exec, shortLots, '空头侧'))) return true;
    } else if (domain === 'neutral') {
      // 中性（dir=0）：hit 且对侧空 → 直平；否则配对减（无趋势保护，EA L2393）
      if (longHit && shortLots.length === 0 && (await this.closeSideExit(ctx, exec, longLots, '多头侧'))) return true;
      if (shortHit && longLots.length === 0 && (await this.closeSideExit(ctx, exec, shortLots, '空头侧'))) return true;
      const hitNet = longHit ? 'LONG' : shortHit ? 'SHORT' : null;
      if (hitNet) {
        const picked = await this.tryPairReduction(
          ctx, exec,
          hitNet === 'LONG' ? longLots : shortLots,
          hitNet === 'LONG' ? shortLots : longLots,
          null,
        );
        if (picked) return true;
      }
    } else {
      // 趋势域：逆势侧达标 → 快跑（EA L3345–3360「逆势快平」）；顺势侧达标 → 对侧空直平、否则趋势保护配对
      const counterLots = trendSide === 'LONG' ? shortLots : longLots;
      const trendLots = trendSide === 'LONG' ? longLots : shortLots;
      const counterHit = trendSide === 'LONG' ? shortHit : longHit;
      const trendHit = trendSide === 'LONG' ? longHit : shortHit;
      if (counterLots.length > 0 && counterHit) {
        if (await this.closeSideExit(ctx, exec, counterLots, `${trendSide === 'LONG' ? '空' : '多'}头逆势侧`)) {
          st.lastNote += '（趋势域逆势快跑）';
          return true;
        }
      }
      if (trendHit) {
        if (counterLots.length === 0 && (await this.closeSideExit(ctx, exec, trendLots, `${trendSide}顺势侧`))) return true;
        if (counterLots.length > 0) {
          const guard: PairGuard = {
            protectLotsQty: trendLots.reduce((a, l) => a + l.quantity, 0),
            riskLotsQty: counterLots.reduce((a, l) => a + l.quantity, 0),
            minRatio: trendProtectionMinRatio(Math.abs(snap.score), trendConfirm),
            maxShare: pairMaxShare,
          };
          if (await this.tryPairReduction(ctx, exec, trendLots, counterLots, guard)) return true;
        }
      }
    }

    // ---- 4) 篮子 arm 尝试（G14 钱口径）：净益 ≥ 名义×启动线 + 1 格金额----
    const startNow =
      (p.useScoreSizing as boolean) && st.regimeSnap
        ? basketStartNow(basketStartPct, snap.score, { trendRange, basketAmpK: basketAmpK as number })
        : basketStartPct;
    if (!st.basketTrailActive && startNow > 0 && netUsdt >= netNotional * startNow + this.gridStep(ctx) * Math.abs(ctx.netQty)) {
      st.basketTrailActive = true;
      st.basketArmed = true; // 与 M3-7 armed 块同步（链内也已维持续单撤挂）
      st.basketPeakPct = Math.max(st.basketPeakPct, netPct);
      st.basketTrailPeakPrice = pnlPrice;
      for (const o of ctx.openOrders) await exec.cancelOrder(o.id);
      st.lastNote = `篮子追踪 arm：净 ${netUsdt.toFixed(2)}U ≥ 名义×${(startNow * 100).toFixed(2)}% + 1 格金额，转价格口径跟踪（峰 ${pnlPrice.toFixed(2)}）`;
      return true;
    }

    return false; // 落篮子兜底（固定 SL/TP；比例追踪已被链接管时自动让位）
  }

  /** 侧目标直平：先撤同向挂单再逐单平（Lot 不可部分平），成功后重置篮子峰值态 */
  private async closeSideExit(
    ctx: StrategyContext,
    exec: StrategyExecutor,
    sideLots: StrategyLotView[],
    label: string,
  ): Promise<boolean> {
    const st = this.stateOf(ctx.instanceId);
    if (sideLots.length === 0) return false;
    const want = sideLots[0].direction;
    for (const o of ctx.openOrders.filter((x) => (x.side === 'BUY') === (want === 'LONG'))) {
      const r = await exec.cancelOrder(o.id);
      if (!r.ok) {
        st.lastNote = `${label}侧目标平仓中止：撤挂单失败（${r.error}）`;
        return true; // 已接管本 tick（保守等待下次重估）
      }
    }
    let closed = 0;
    for (const l of sideLots) {
      const r = await exec.closeLot(l.id, 'TAKE_PROFIT');
      if (r.ok) closed++;
      else this.logger.warn(`${label}侧目标平仓失败 lot=${l.id}: ${r.error}`);
    }
    st.basketPeakPct = 0;
    st.basketArmed = false;
    st.basketTrailActive = false;
    st.basketTrailPeakPrice = 0;
    const pnl = sideLots.reduce((a, l) => a + l.unrealizedPnl, 0) - sideLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0) * EXIT_FEE_RATE;
    st.lastNote = `${label}均值目标达成：净 ${pnl.toFixed(2)}U，已平 ${closed}/${sideLots.length} 单`;
    this.logger.log(st.lastNote);
    return true;
  }

  /**
   * 配对减仓（G6 两段式，EA L2455–2504）：预检选对 → 撤全部挂单 →
   * 同快照重估（防撤单竞态）→ 两单全平（profit+SIGNAL / risk+SIGNAL，归因 note 标配对）。
   */
  private async tryPairReduction(
    ctx: StrategyContext,
    exec: StrategyExecutor,
    profitLots: StrategyLotView[],
    riskLots: StrategyLotView[],
    guard: PairGuard | null,
  ): Promise<boolean> {
    const st = this.stateOf(ctx.instanceId);
    const pick = findReductionPair({
      profitLots: this.sideViews(ctx, profitLots),
      riskLots: this.sideViews(ctx, riskLots),
      minNet: 0.01, // EA PAIR_CLOSE_MIN_NET L31
      guard,
    });
    if (!pick) return false;
    for (const o of ctx.openOrders) {
      const r = await exec.cancelOrder(o.id);
      if (!r.ok) {
        st.lastNote = `配对减中止：撤挂单失败（${r.error}）`;
        return true;
      }
    }
    // 重估（EA L2470 二次 CollectStats）：快照未变时结果一致，防御性再核对净值仍达标
    const rePick = findReductionPair({
      profitLots: this.sideViews(ctx, profitLots),
      riskLots: this.sideViews(ctx, riskLots),
      minNet: 0.01,
      guard,
    });
    if (!rePick || rePick.profit.id !== pick.profit.id || rePick.risk.id !== pick.risk.id) {
      st.lastNote = '配对减重估落空（快照已变），本 tick 不动作';
      return true;
    }
    const rp = await exec.closeLot(pick.profit.id, 'SIGNAL');
    const rr = await exec.closeLot(pick.risk.id, 'SIGNAL');
    st.basketPeakPct = 0;
    st.basketArmed = false;
    st.lastNote = `配对减：盈单 ${pick.profit.id}(${pick.profit.netUsdt.toFixed(2)}U) + 亏单 ${pick.risk.id}(${pick.risk.netUsdt.toFixed(2)}U) 净 ${pick.net.toFixed(2)}U ${rp.ok && rr.ok ? '已平' : '平仓有失败，下 tick 重估'}`;
    this.logger.log(st.lastNote);
    return true;
  }

  /** Lot → 配对选对视图（净益/不利距离均按判定基准价） */
  private sideViews(ctx: StrategyContext, lots: StrategyLotView[]): LotNetView[] {
    const pnlPrice = this.pnlPriceOf(ctx);
    return lots.map((l) => ({
      id: l.id,
      direction: l.direction === 'SHORT' ? 'SHORT' : 'LONG',
      quantity: l.quantity,
      netUsdt: l.unrealizedPnl - l.entryPrice * l.quantity * EXIT_FEE_RATE,
      adverseDist: l.direction === 'LONG' ? Math.max(0, l.entryPrice - pnlPrice) : Math.max(0, pnlPrice - l.entryPrice),
    }));
  }

  /**
   * 篮子追踪止盈 + 篮子止损。
   *
   * 口径：净收益率 = (Σ 浮动盈亏 − 预估平仓手续费) / Σ 开仓名义。
   * 触及止损，或「曾达到启动阈值且回撤超过 giveback」即全平所有仓位单。
   */
  private async checkBasketExit(
    ctx: StrategyContext,
    exec: StrategyExecutor,
    disableTrail = false,
  ): Promise<boolean> {
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as {
      basketStartPct: number;
      basketGivebackPct: number;
      basketStopLossPct: number;
      basketTakeProfitUsdt: number;
      basketStopLossUsdt: number;
      useScoreSizing: boolean;
      trendRange: number;
      basketAmpK: number;
    };
    const netNotional = ctx.openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
    if (!(netNotional > 0)) return false;

    const gross = ctx.openLots.reduce((a, l) => a + l.unrealizedPnl, 0);
    const exitFee = netNotional * EXIT_FEE_RATE;
    // 净收益：USDT 绝对额与比例两个口径同源（都扣了预估平仓费），供固定/比例两套阈值共用判定
    const netUsdt = gross - exitFee;
    const netPct = netUsdt / netNotional;

    if (netPct > st.basketPeakPct) st.basketPeakPct = netPct;

    // 启动线动态化（EA DynamicCloseAllTarget L1671，M2）：趋势越强，篮子目标越高
    // （多给空间换更大轮次收益）；关断态回退固定 basketStartPct（老行为）。
    const startNow =
      p.useScoreSizing && st.regimeSnap
        ? basketStartNow(p.basketStartPct, st.regimeSnap.score, {
            trendRange: p.trendRange,
            basketAmpK: p.basketAmpK,
          })
        : p.basketStartPct;

    // armed 标志（M3-7 消费）：峰值达启动线即进入 armed，与是否触发 giveback 离场无关
    st.basketArmed = startNow > 0 && st.basketPeakPct >= startNow;

    let reason: 'TAKE_PROFIT' | 'STOP_LOSS' | null = null;
    // 止损：比例止损 或 固定金额止损，任一触发即平
    const slByPct = p.basketStopLossPct > 0 && netPct <= -p.basketStopLossPct;
    const slByUsdt = p.basketStopLossUsdt > 0 && netUsdt <= -p.basketStopLossUsdt;
    // 止盈：固定金额达标（不追踪）或 比例追踪止盈，任一触发即平
    const tpByUsdt = p.basketTakeProfitUsdt > 0 && netUsdt >= p.basketTakeProfitUsdt;
    // 出场链开启时比例追踪让位给 G14 双口径（链内管理），固定 SL/TP 保留为最外层保险
    // netPct > 0 闸（2026-10-16 A9）：深亏时「峰值-现值」回撤也会超 giveback，
    // 不加闸会把大亏平仓误记成 TAKE_PROFIT（与 V1 同修）
    const tpByTrail =
      !disableTrail &&
      startNow > 0 &&
      netPct > 0 &&
      st.basketPeakPct >= startNow &&
      st.basketPeakPct - netPct >= p.basketGivebackPct;

    if (slByPct || slByUsdt) {
      reason = 'STOP_LOSS';
    } else if (tpByUsdt || tpByTrail) {
      reason = 'TAKE_PROFIT';
    }

    if (!reason) {
      st.lastNote = `篮子净收益 ${netUsdt.toFixed(2)}U / ${(netPct * 100).toFixed(2)}%（峰值 ${(st.basketPeakPct * 100).toFixed(2)}%）`;
      return false;
    }

    // 出场已在进行中（平仓单在途）：本 tick 只等结果，不重复下单也不挂新单。
    // 缺这道闸会让同一个 Lot 被平两次——第二次在已无仓位时就成了反向开仓。
    const inflight = ctx.openLots.filter((l) => l.hasPendingClose).length;
    if (inflight > 0) {
      st.lastNote = `篮子出场进行中（${inflight}/${ctx.openLots.length} 单在途），等待成交`;
      return true;
    }

    // 全平：先撤掉所有挂单，再逐 Lot 市价全平（Lot 模型禁止部分平仓）。
    // 撤单失败必须中止本轮出场——否则挂单可能在平仓的同时被触发建新仓。
    for (const order of ctx.openOrders) {
      const r = await exec.cancelOrder(order.id);
      if (!r.ok) {
        st.lastNote = `篮子出场中止：撤销挂单失败（${r.error}）`;
        this.logger.warn(st.lastNote);
        return true;
      }
    }
    for (const lot of ctx.openLots) {
      const r = await exec.closeLot(lot.id, reason);
      if (!r.ok) this.logger.warn(`篮子出场平仓失败 lot=${lot.id}: ${r.error}`);
    }
    st.basketPeakPct = 0;
    // 止损后冷却的时间基准（2026-10-16）：只认 STOP_LOSS，止盈不触发冷却
    if (reason === 'STOP_LOSS') st.lastStopAt = ctx.now;
    st.lastNote = `篮子${reason === 'TAKE_PROFIT' ? '止盈' : '止损'}：净收益 ${netUsdt.toFixed(2)}U / ${(netPct * 100).toFixed(2)}%，已全平 ${ctx.openLots.length} 单`;
    this.logger.log(st.lastNote);
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
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as {
      enabledSides: string;
      useTrendFilter: boolean;
      trendMaPeriod: number;
      useBrain: boolean;
    };
    const sideLimit = p.enabledSides;
    const longOk = sideLimit !== 'shortOnly';
    const shortOk = sideLimit !== 'longOnly';

    const longLots = ctx.openLots.filter((l) => l.direction === 'LONG');
    const shortLots = ctx.openLots.filter((l) => l.direction === 'SHORT');

    if (!p.useTrendFilter) {
      return { allowLong: longOk, allowShort: shortOk };
    }

    // M5 pivot alarm（EA L3449–3456）：单侧持仓深陷浮亏且近 N 根累计逆行超阈值
    // → 放行双侧 carry（允许对侧铺网格抗趋势，**不平老仓**——EA 同样只撤单边限制）。
    const pr = ctx.params as Record<string, unknown>;
    if (pr.usePivotCarry === true && st.regimeSnap && (longLots.length > 0) !== (shortLots.length > 0)) {
      const holdingLong = longLots.length > 0;
      const heldLots = holdingLong ? longLots : shortLots;
      const heldNet = heldLots.reduce((a, l) => a + l.unrealizedPnl, 0);
      const equity = trueEquity(ctx);
      const lossGate = Math.max(50, equity * (pr.pivotLossPct as number));
      if (heldNet < -lossGate) {
        const cs = ctx.candles;
        const lb = pr.pivotLookback as number;
        if (cs.length > lb) {
          const mom = cs[cs.length - 1].close / cs[cs.length - 1 - lb].close - 1;
          const adverse = holdingLong ? -mom : mom; // 对持仓侧不利：LONG 怕跌 / SHORT 怕涨
          if (adverse >= (pr.pivotMomPct as number)) {
            st.pivotAlarm = true; // stateV:2 标志：carry 模式高亮源（仅观察）
            st.lastNote = `pivot 警报：持仓侧浮亏 ${heldNet.toFixed(2)}U < −${lossGate.toFixed(0)}U 且 ${lb} 根逆行 ${(adverse * 100).toFixed(2)}%，放行双侧 carry`;
            return { allowLong: longOk, allowShort: shortOk };
          }
        }
      }
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

    // 两侧都空 → 定向。useBrain 开启时换用 Brain：粘滞域机 dir 优先
    // （自带防抖，翻转需 TrendDirEnter 证据），dir=0 才看 score 符号（M5）。
    if (p.useBrain && st.regimeSnap) {
      const s = st.regimeSnap;
      const dirScore = s.dir !== 0 ? s.dir : Math.sign(s.score);
      return {
        allowLong: longOk && dirScore >= 0,
        allowShort: shortOk && dirScore < 0,
      };
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

    if (allowLong) await this.ensureSide('LONG', longLots, shortLots, pendingBuy, ctx, exec);
    if (allowShort) await this.ensureSide('SHORT', shortLots, longLots, pendingSell, ctx, exec);
  }

  /**
   * 单侧网格：决定是否挂下一层，以及挂在哪里。
   *
   * EA 语义（`TryPlacePendingOrders` L4045–4123）：
   * - 该侧无持仓且无挂单 → 挂首层，距现价 `firstStep`
   * - 该侧已有持仓 → EA 原语义（G9）：现价相对最不利持仓逆行 **2 个网格**
   *   且相对合并极值（持仓∪挂单）逆行 1 格才挂回归确认单；再平衡失衡资格
   *   成立且突破本方极值时也可挂（L4053/L4073）。老策略的 1 格版是移植走样，
   *   保留作 E0 基线；usePendingDiscipline 开 → 恢复 EA 语义。
   * - 该侧已有挂单 → 老行为不重复挂；纪律态逐 tick 重算应挂价，只向现价
   *   方向偏离 ≥ 地板即撤旧换新（G8 挂单跟踪，L4125–4181）
   * - 侧上限撤挡 / 保证金预检 / funding 窗 / 触发地板 → M3-4/5/8，开启态专属
   */
  private async ensureSide(
    dir: LotDirection,
    lots: StrategyLotView[],
    oppLots: StrategyLotView[],
    pendings: StrategyOrderView[],
    ctx: StrategyContext,
    exec: StrategyExecutor,
  ): Promise<void> {
    const st = this.stateOf(ctx.instanceId);
    const p = ctx.params as {
      baseQty: number;
      lotMultiplier: number;
      maxLayersPerSide: number;
      firstStepAtrMult: number;
      leverage: number;
      firstOrderMarket: boolean;
      cooldownAfterStopSec: number;
      useScoreSizing: boolean;
      trendMultMin: number;
      trendRange: number;
      trendStrong: number;
      usePendingDiscipline: boolean;
      pauseAroundFunding: boolean;
      rebalanceRatio: number;
      pendingTrailStepPct: number;
      minTriggerDistPct: number;
      marginGuardFree: number;
      marginGuardEquity: number;
    };
    // 止损后冷却（2026-10-16，与 V1 同语义同默认）：本侧无持仓且无挂单时，
    // 距上次篮子止损不足 N 秒则本 tick 不开——切断震荡市
    // 「止损 → 反弹追入 → 再止损」的碎钞循环。
    if (
      lots.length === 0 &&
      pendings.length === 0 &&
      p.cooldownAfterStopSec > 0 &&
      ctx.now - st.lastStopAt < p.cooldownAfterStopSec * 1000
    ) {
      const remain = Math.ceil((p.cooldownAfterStopSec * 1000 - (ctx.now - st.lastStopAt)) / 1000);
      st.lastNote = `止损冷却中（剩余 ${remain}s），暂停开新首层`;
      return;
    }
    const disc = p.usePendingDiscipline;
    const side: Side = dir === 'LONG' ? 'LONG' : 'SHORT';

    // M3-4 侧上限撤挡（EA L4119–4122）：已成交层数达帽 → 撤本侧挂单，防触发超帽
    if (disc && lots.length >= p.maxLayersPerSide) {
      for (const o of pendings) await exec.cancelOrder(o.id);
      if (pendings.length > 0) {
        st.lastNote = `${dir} 侧层数达帽 ${lots.length}/${p.maxLayersPerSide}：已撤挂单挡口`;
      }
      return;
    }

    const layers = lots.length + pendings.length;
    if (layers >= p.maxLayersPerSide) return;

    // 手数 = 首层 × 倍率^已层数（EA: EffectiveBaseLot × pow(multiplier, positions)）。
    // useScoreSizing 开 → 趋势压平倍率（EA DynamicLotMultiplier L1638：
    // 震荡域敢用 >1 倍率，强趋势退回近等权，防爆仓式倍增）。
    const mult =
      p.useScoreSizing && st.regimeSnap
        ? scoreLotMultiplier(st.regimeSnap.score, p.lotMultiplier, p.trendMultMin, {
            trendRange: p.trendRange,
            trendStrong: p.trendStrong,
          })
        : p.lotMultiplier;
    const qty = Number((p.baseQty * Math.pow(mult, layers)).toFixed(8));
    if (!(qty > 0)) return;

    // M3-5 护栏扩展（独立开关）：funding 结算窗 ±15min 暂停本侧一切新开层/换单
    if (p.pauseAroundFunding && nearFundingWindow(ctx.now)) {
      st.lastNote = `${dir} funding 结算窗（±15min）暂停开新层`;
      return;
    }

    // 首层市价开仓（可选，默认开）：
    // EA 原样是挂 STOP 单等价格突破，但「等突破」在行情平静时可能几十分钟不成交，
    // 测试/验证阶段就完全看不到策略行为。开启后立即市价开首层，
    // **后续加层仍按网格挂单**（加层语义不受影响，依旧忠于 EA）。
    //
    // 若首层挂单还在等突破，先撤掉它——否则挂单会一直挡在前面，
    // 既等不到突破、又走不到市价，变成「什么都不做」的僵局。
    if (lots.length === 0 && p.firstOrderMarket === true) {
      if (disc) {
        // M3-6 首 K 线锁：同一根执行周期 K 线内不重复市价开首层（替代 20s 时间戳去重）
        const barT = ctx.candles.length > 0 ? ctx.candles[ctx.candles.length - 1].time : 0;
        if (barT > 0 && barT === st.firstMarketBarTime) return;
        if (barT > 0) st.firstMarketBarTime = barT;
      } else {
        // 与 disc 分支同款 K 线锁（2026-10-16 B8 统一）：20s 时间戳会被
        // demo 异步成交的对账延迟（可达 60s）击穿 → 首层开 2~3 倍仓位
        const barT = ctx.candles.length > 0 ? ctx.candles[ctx.candles.length - 1].time : 0;
        if (barT > 0 && barT === st.firstMarketBarTime) return;
        if (barT > 0) st.firstMarketBarTime = barT;
      }

      for (const o of pendings) {
        await exec.cancelOrder(o.id);
      }
      // 首层手数恒为 baseQty（第 1 层，不乘倍率）。
      // 不能用上面的 qty：那里的 layers 把「等待中的遗留挂单」也算进去了，
      // 会把首层算成第 2 层的量（baseQty × 1.5）。
      const firstQty = Number(Number(p.baseQty).toFixed(8));
      // M3-5 保证金预检（市价首层也过闸；不足则本根 K 线内不再重试，下根再来）
      if (disc && !this.marginOk(ctx, ctx.price * firstQty, p)) return;
      const r = await exec.openLot({
        direction: dir,
        quantity: firstQty,
        leverage: p.leverage,
        reason: `grid-${dir.toLowerCase()}-L1-market`,
      });
      if (r.lotId || r.error === undefined) {
        st.lastNote = `市价开 ${dir} 首层 × ${firstQty}（${p.leverage}x）`;
        this.logger.log(st.lastNote);
      } else if (r.error) {
        st.firstMarketBarTime = 0; // 失败则允许下一 tick 重试
        st.firstMarketBarTime = 0; // 不消耗 K 线锁
        st.lastNote = `市价开 ${dir} 首层失败：${r.error}`;
        this.logger.warn(st.lastNote);
      }
      return;
    }

    if (pendings.length > 0) {
      if (!disc) return; // 老行为：已有待成交层，等它触发或撤销
      // M3-3 挂单跟踪（EA TryTrailPendingOrders L4125–4181）：重算应挂价，
      // 只向现价方向跟踪、偏离 ≥ pendingTrailStepPct·price 才撤旧换新（手数不变）。
      const target = this.disciplineTarget(ctx, side, lots, pendings, oppLots, p);
      if (target == null) return;
      const pend = pendings[0];
      if (!shouldTrail(side, pend.stopPrice, target, ctx.price * p.pendingTrailStepPct)) return;
      if (!this.marginOk(ctx, target * pend.quantity, p)) return;
      const c = await exec.cancelOrder(pend.id);
      if (!c.ok) {
        st.lastNote = `跟踪换单撤旧失败：${c.error}`;
        this.logger.warn(st.lastNote);
        return;
      }
      const r = await exec.placeStopOrder({
        direction: dir,
        stopPrice: target,
        quantity: pend.quantity,
        leverage: p.leverage,
        reason: `grid-${dir.toLowerCase()}-L${layers + 1}-trail`,
      });
      if (r.orderId) {
        st.lastNote = `跟踪换单 ${dir} @ ${pend.stopPrice.toFixed(2)} → ${target.toFixed(2)} × ${pend.quantity}`;
        this.logger.log(st.lastNote);
      } else if (r.error) {
        st.lastNote = `跟踪换单挂新失败：${r.error}`;
        this.logger.warn(st.lastNote);
      }
      return;
    }

    const step = this.gridStepFor(ctx, dir);
    if (!(step > 0)) return;

    let stopPrice: number;
    if (disc) {
      // 纪律态：资格闸（G9 两格回归 / 再平衡突破）+ 触发地板（M3-8）+ 保证金预检（M3-5）
      const t = this.disciplineTarget(ctx, side, lots, [], oppLots, p);
      if (t == null) return;
      stopPrice = t;
      if (!this.marginOk(ctx, stopPrice * qty, p)) return;
    } else {
      const firstStep = Math.max(step, this.atrOf(ctx.candles) * p.firstStepAtrMult);
      if (lots.length === 0) {
        // 首层：无条件挂（EA: buy_positions == 0 即挂）
        stopPrice = dir === 'LONG' ? ctx.price + firstStep : ctx.price - firstStep;
      } else {
        const worst =
          dir === 'LONG'
            ? Math.min(...lots.map((l) => l.entryPrice))
            : Math.max(...lots.map((l) => l.entryPrice));
        // 加层触发（老策略的 1 格近似，保留作 E0 基线）：EA 原式
        // target=ask+step ≤ lowest_position−step ⟺ 现价逆行 2 格（G9），
        // 纪律开启后由 disciplineTarget 恢复。曾误写成 2 格把加层线翻倍，
        // 实际表现就是「只下一单、再也不加层」。
        const goneFar = dir === 'LONG' ? ctx.price <= worst - step : ctx.price >= worst + step;
        if (!goneFar) return;
        // 在现价外侧一步处挂突破单：等价格回头确认再进
        stopPrice = dir === 'LONG' ? ctx.price + step : ctx.price - step;
      }
    }

    if (!(stopPrice > 0)) return;

    const r = await exec.placeStopOrder({
      direction: dir,
      stopPrice,
      quantity: qty,
      // 策略自己声明杠杆，避免「参数写 5x、实际按配置 12x 下单」的不一致
      leverage: p.leverage,
      reason: `grid-${dir.toLowerCase()}-L${layers + 1}`,
    });
    if (r.orderId) {
      st.lastNote = `挂 ${dir} 第 ${layers + 1} 层 @ ${stopPrice.toFixed(2)} × ${qty}（${p.leverage}x）`;
      this.logger.log(st.lastNote);
    } else if (r.error) {
      st.lastNote = `挂 ${dir} 第 ${layers + 1} 层失败：${r.error}`;
      this.logger.warn(st.lastNote);
    }
  }

  /**
   * 纪律态「应挂价」（挂新层与跟踪换单共用）：
   * 资格闸 = EA buy/sell_condition（无持仓→first；逆行 2 格且极值外 1 格→
   * regression；失衡资格且突破本方极值→rebalance；否则拒绝），
   * 应挂价再套 minTriggerDistPct 触发地板（M3-8）。
   */
  private disciplineTarget(
    ctx: StrategyContext,
    side: Side,
    lots: StrategyLotView[],
    orders: StrategyOrderView[],
    oppLots: StrategyLotView[],
    p: {
      baseQty: number;
      firstStepAtrMult: number;
      rebalanceRatio: number;
      minTriggerDistPct: number;
    },
  ): number | null {
    const step = this.gridStepFor(ctx, side);
    if (!(step > 0)) return null;
    const ext = sideExtremes(lots, orders);
    const rebalance = rebalanceEligible({
      ourQty: lots.reduce((a, l) => a + l.quantity, 0),
      oppQty: oppLots.reduce((a, l) => a + l.quantity, 0),
      baseQty: p.baseQty,
      ratio: p.rebalanceRatio,
    });
    const via = canAddLayer({ side, price: ctx.price, step, ext, rebalance });
    if (via == null) return null;
    const firstStep = Math.max(step, this.atrOf(ctx.candles) * p.firstStepAtrMult);
    const raw =
      via === 'first'
        ? side === 'LONG'
          ? ctx.price + firstStep
          : ctx.price - firstStep
        : side === 'LONG'
          ? ctx.price + step
          : ctx.price - step;
    return applyTriggerFloor(side, raw, ctx.price, p.minTriggerDistPct);
  }

  /** M3-5 保证金/敞口预检（EA CanAffordOrder L1936）：占用=名义/杠杆，权益≈可用+浮盈亏 */
  private marginOk(
    ctx: StrategyContext,
    notional: number,
    p: { leverage: number; marginGuardFree: number; marginGuardEquity: number },
  ): boolean {
    const st = this.stateOf(ctx.instanceId);
    // 真权益 = 钱包余额 + 浮盈（2026-10-16 B4）：availableMargin 是 availableBalance，
    // 本身已含浮盈且已扣已用保证金——再叠加浮盈=双算，且不计已占用，深亏时误拦加层
    const equity = trueEquity(ctx);
    const ok = marginPrecheck({
      availableMargin: ctx.availableMargin,
      equity,
      notional,
      leverage: p.leverage,
      freeK: p.marginGuardFree,
      equityK: p.marginGuardEquity,
    });
    if (!ok) {
      st.marginBlocked = true; // stateV:2 暂停徽章 margin 位（仅本 tick，链顶复位）
      st.lastNote = `保证金预检拦截：预计占用 ${(notional / p.leverage).toFixed(2)}U（可用 ${ctx.availableMargin.toFixed(0)}U / 权益 ${equity.toFixed(0)}U）`;
      this.logger.warn(st.lastNote);
    }
    return ok;
  }

  /** 网格间距：ATR 驱动并钳制在 [minStepPct, maxStepPct] 之间（震荡域基准 s0） */
  private gridStep(ctx: StrategyContext): number {
    const p = ctx.params as { stepAtrMult: number; minStepPct: number; maxStepPct: number };
    const a = this.atrOf(ctx.candles);
    const byAtr = a > 0 ? a * p.stepAtrMult : 0;
    const min = ctx.price * p.minStepPct;
    const max = ctx.price * p.maxStepPct;
    const raw = byAtr > 0 ? byAtr : min;
    return Math.min(max, Math.max(min, raw));
  }

  /**
   * 方向不对称间距（EA DirectionalGridStepPoints L1519，M2）：
   * useScoreSizing 开且 Brain 有快照时，在基准 s0 上乘方向倍率；否则回退 s0（老行为）。
   */
  private gridStepFor(ctx: StrategyContext, dir: LotDirection): number {
    const st = this.stateOf(ctx.instanceId);
    const base = this.gridStep(ctx);
    const p = ctx.params as Record<string, unknown>;
    if (!p.useScoreSizing || !st.regimeSnap) return base;
    return directionalStep(base, st.regimeSnap.score, dir === 'LONG' ? 'LONG' : 'SHORT', this.sizingCfg(p));
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
