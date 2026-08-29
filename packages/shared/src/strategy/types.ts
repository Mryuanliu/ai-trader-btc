import type { PositionSnapshot, Timeframe } from '../types/common';
import type { Candle, Ticker } from '../types/market';
import type { IndicatorSnapshot, Signal } from '../types/agent';

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

/** 策略输出（映射为决策记录） */
export interface StrategyOutput {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
  riskNotes?: string;
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
}
