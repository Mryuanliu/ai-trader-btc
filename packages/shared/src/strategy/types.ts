import type { PositionSnapshot, Timeframe } from '../types/common';
import type { RsiMode } from '../indicators/signals';
import type { Candle, Ticker } from '../types/market';
import type { IndicatorSnapshot, Signal } from '../types/agent';
import type { DecisionDiagnostics } from '../decision-diagnostics';

/**
 * 策略输入的只读上下文。
 *
 * 由 AgentEngine（实盘）或回测引擎从「共享前置快照」构造：
 * 行情 → 指标计算 → 信号 → 持仓/余额。策略本身只做纯函数计算，无 I/O。
 */
export interface StrategyContext {
  symbol: string;
  timeframe: Timeframe;
  /** 按时间升序的 K 线（含未闭合的最后一根） */
  candles: Candle[];
  /** 已计算的指标快照 */
  indicators: IndicatorSnapshot;
  /** 预设信号（复用 buildSignals，策略也可自行计算） */
  signals: Signal[];
  /** 六信号加权合成倾向 -1~1（与 DecisionInputSnapshot.indicatorScore 同源同值） */
  indicatorScore: number;
  ticker: Ticker;
  /** 当前持仓快照；无持仓或无法推导时为 null */
  position: PositionSnapshot | null;
  /** 账户可用余额 */
  account: { quoteFree: number; baseFree: number };
  /** 已由 normalizeParams 合并默认值的策略参数 */
  params: Record<string, unknown>;
}

/**
 * 策略输出（映射为决策记录）
 *
 * 语义约定：
 * - `confidence`：**开仓信号强度**，仅当 action≠HOLD 时有意义（参与 minConfidence 拦截）。
 *   观望时为 0，避免误用。
 * - `proximity`：**接近度** 0~1，表示「当前倾向已达到触发所需的百分比」。
 *   观望时仍携带信息量——proximity=0.76 即「已达 76%，还差 24%」。
 *   新增此字段而非改 confidence，是为了不破坏 minConfidence 拦截与回测仓位口径（零风险增量）。
 * - `diagnostics`：结构化归因（阻塞原因码 + 信号贡献），用于「为什么没开单」的下钻排查。
 */
export interface StrategyOutput {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
  riskNotes?: string;
  /** 接近度 0~1：|score| / entryThreshold（观望时仍有效，表达「差多少」） */
  proximity?: number;
  /** 观望/拒单时的结构化归因 */
  diagnostics?: DecisionDiagnostics;
}

/** 策略契约：新增一个策略 = 实现本接口 + 在 strategy/index.ts 注册 */
export interface Strategy {
  /** 唯一标识，对应配置中的 strategyName */
  readonly name: string;
  /** 展示名 */
  readonly label: string;
  readonly description: string;
  readonly defaultParams: Record<string, unknown>;
  /** 参数 JSON Schema，供阶段 6 前端动态渲染表单 */
  readonly paramSchema?: Record<string, unknown>;
  /**
   * 校验并合并外部参数与默认值，返回干净参数。
   * 非法值回落默认：策略永不因参数崩溃。
   */
  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown>;
  evaluate(ctx: StrategyContext): StrategyOutput;
  /**
   * 该策略要求的 RSI 语义（B3）。
   * - 'reversion'（默认）：超买看跌、超卖看涨 —— 适合均值回归/高抛低吸
   * - 'trend'：高 RSI 代表动能强、看涨 —— 适合趋势跟随/追涨杀跌
   *
   * 引擎构造信号时按此应用，避免「趋势策略在超买区反而收到看跌票」的语义反转
   * （实测 RSI>=70 时旧实现 794 次全判 bearish，与 RSI 55~70 的 bullish 方向相反）。
   */
  readonly rsiMode?: RsiMode;
}
