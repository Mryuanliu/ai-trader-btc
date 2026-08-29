import type { Candle, Ticker } from '../../types/market';
import { buildSignals, computeIndicators, scoreSignals, Signal } from '../../indicators/signals';
import type { StrategyContext } from '../../strategy/types';

/**
 * 迁移基准（oracle）：原 AgentEngine.fallbackDecision() 的逐字复刻。
 *
 * 来源：apps/server/src/agent/agent-engine.service.ts（迁移前版本 L296-310）。
 * 用途：验证 trend_following 策略迁移后的 action/confidence 与旧实现完全一致。
 * 阶段 3 修复策略缺陷后，本文件将被删除（届时新旧行为预期分离）。
 */
export function fallbackDecisionOracle(snapshot: {
  indicatorScore: number;
}): { action: 'BUY' | 'SELL' | 'HOLD'; confidence: number } {
  const score = snapshot.indicatorScore;
  const magnitude = Math.min(1, Math.abs(score));
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if (score >= 0.25) action = 'BUY';
  else if (score <= -0.25) action = 'SELL';

  return {
    action,
    confidence: Number((0.45 + magnitude * 0.4).toFixed(2)),
  };
}

/** 用真实 K 线窗口构造 oracle 输入（与引擎 buildSnapshot 同路径计算 indicatorScore） */
export function oracleFromCandles(candles: Candle[]): { indicatorScore: number } & ReturnType<
  typeof fallbackDecisionOracle
> {
  const indicators = computeIndicators(candles);
  const signals = buildSignals(indicators, candles);
  const indicatorScore = scoreSignals(signals);
  return { indicatorScore, ...fallbackDecisionOracle({ indicatorScore }) };
}

/** 构造策略上下文（测试用，strategy 感知的字段之外给最小值） */
export function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const candles: Candle[] = overrides.candles ?? [];
  const indicators = computeIndicators(candles);
  const signals: Signal[] = overrides.signals ?? buildSignals(indicators, candles);
  return {
    symbol: 'BTCUSDT',
    timeframe: '5m',
    candles,
    indicators,
    signals,
    indicatorScore: scoreSignals(signals),
    ticker: {
      symbol: 'BTCUSDT',
      price: 80000,
      change24h: 0,
      changePercent24h: 0,
      high24h: 80000,
      low24h: 80000,
      quoteVolume24h: 0,
      volume24h: 0,
      ts: 0,
    } satisfies Ticker,
    position: null,
    account: { quoteFree: 10000, baseFree: 0 },
    params: {},
    ...overrides,
  };
}
