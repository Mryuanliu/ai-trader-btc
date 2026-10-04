import type { Candle, Timeframe } from '@ai-trader/shared';

/**
 * event-driven 撮合引擎 v1 的事件与配置类型。
 *
 * 与 vectorized 引擎的关系（方案 A2 双引擎）：
 * - **vectorized**（`runBacktestOnCandles`）：bar 粒度、`SimBroker.beginBar` 每 bar 一次触发；
 *   仍用于 sweep 快速粗筛（网格扫参）。
 * - **event-driven-v1**（本模块）：以 aggTrade 为主时间轴 + markPrice/funding 精确入账 + STOP 逐笔触发；
 *   用于研究/闸门定稿。
 *
 * 引擎版本号 `event-driven-v1` 表示：
 * ✅ aggTrade intrabar 逐笔 STOP 触发 / markPrice 独立于 close / funding 8h 精确结算 / 分层强平判定
 * ⏳ L2 队列模型（本表空）、半点差 VWAP 吃深度、市场冲击平方根律、latency 20ms 单边 → **P1b 补**
 * 因此方案 A6 的 `engine_v2` 判据在 v1 仍标 `pending`，不冒充完整保真。
 */

export const ENGINE_VERSION_V1 = 'event-driven-v1';

/** 事件流的原子单元：一切按 ts 归并后回放 */
export type MarketEvent =
  | { kind: 'aggTrade'; ts: number; price: number; qty: number; isBuyerMaker: boolean }
  | { kind: 'markPrice'; ts: number; markPrice: number }
  | { kind: 'fundingSettlement'; ts: number; rate: number; markPrice: number }
  | { kind: 'bar'; ts: number; bar: Candle; interval: Timeframe };

/** 事件按 ts 升序、同 ts 内按 kind 优先级（markPrice < aggTrade < fundingSettlement < bar） */
export const EVENT_KIND_ORDER: Record<MarketEvent['kind'], number> = {
  markPrice: 0,
  aggTrade: 1,
  fundingSettlement: 2,
  bar: 3,
};

/** 引擎入口配置（与 vectorized BacktestConfig 兼容，扩展数据源） */
export interface EventDrivenConfig {
  symbol: string;
  interval: Timeframe;
  from: number;
  to: number;
  initialCapital: number;
  warmupBars: number;
  /** taker 费率（小数单边），默认 FUTURES_TAKER_FEE_RATE */
  feeRateBps: number;
  /** 无 L2 时的兜底滑点（小数单边）；有 aggTrade 用成交价则不再叠加 */
  slippageBps: number;
  /** 无 aggTrade 数据时的降级：允许用 bar 近似（默认 false：false 时数据缺失直接抛错） */
  allowBarFallback?: boolean;
  /** 强平维持保证金率（无 symbol_meta 时的兜底；默认 0.005 = 0.5%） */
  defaultMaintMarginRatio?: number;
}

/** 引擎产出的每 tick 决策上下文（与 vectorized 一致，方便策略无改动跑双引擎） */
export interface EngineStats {
  aggTradeCount: number;
  markPriceCount: number;
  fundingEvents: number;
  barsProcessed: number;
  stopTriggers: number;
  liquidations: number;
}
