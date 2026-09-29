/**
 * 回测台类型（服务端入口）。
 *
 * P0+ 起类型统一定义在 `@ai-trader/shared`（`types/backtest.ts`），
 * 前后端共用单一来源；此处仅再导出，保持既有 `from './backtest.types'` 引用不破。
 */
export type {
  BacktestConfig,
  BacktestTrade,
  EquityPoint,
  BacktestMetrics,
  CostBreakdown,
  BacktestReport,
  BacktestResult,
  WalkForwardSegment,
  WalkForwardResult,
  CpcvResult,
  DeflatedSharpeResult,
  ResearchResult,
  SweepCell,
  SweepResult,
  LookaheadCheckResult,
  BacktestRunKind,
  BacktestRunSummary,
} from '@ai-trader/shared';
