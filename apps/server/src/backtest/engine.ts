import {
  Candle,
  Strategy,
  StrategyContext,
  buildSignals,
  computeIndicators,
  computePosition,
  scoreSignals,
} from '@ai-trader/shared';
import type { PositionFill } from '@ai-trader/shared';
import { computeMetrics } from './metrics';
import type { BacktestConfig, BacktestReport, BacktestTrade, EquityPoint } from './types';

/**
 * 回测引擎：事件驱动回放 + 纯函数。
 *
 * 确定性约束：无随机源、无 Date.now()，所有时间来自 K 线本身，
 * 同一输入连跑两次输出逐字节一致。
 *
 * 成交口径：第 i 根收盘决策，以第 i+1 根开盘价成交（加滑点），
 * 无前视偏差且相对实盘偏保守。
 */
export function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  config: BacktestConfig,
): BacktestReport {
  const WINDOW = 200; // 与实盘 HISTORY_LIMIT 对齐
  const slippage = config.slippageBps / 10_000;
  const feeRate = config.feeRateBps / 10_000;

  let quoteFree = config.initialCapital;
  let baseFree = 0;
  const fills: PositionFill[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [
    { time: candles[0]?.time ?? 0, equity: config.initialCapital, drawdownPct: 0 },
  ];

  for (let i = config.warmupBars; i < candles.length - 1; i++) {
    // ---- 在第 i 根收盘时构造上下文并决策 ----
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const indicators = computeIndicators(window);
    const signals = buildSignals(indicators, window);
    const indicatorScore = scoreSignals(signals);
    const price = candles[i].close;

    const context: StrategyContext = {
      symbol: config.symbol,
      timeframe: config.interval,
      candles: window,
      indicators,
      signals,
      indicatorScore,
      ticker: {
        symbol: config.symbol,
        price,
        change24h: 0,
        changePercent24h: 0,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
        quoteVolume24h: 0,
        ts: price > 0 ? candles[i].time : 0,
      },
      position: computePosition(config.symbol, fills, price),
      account: { quoteFree, baseFree },
      params: strategy.normalizeParams(config.strategyParams),
    };

    const output = strategy.evaluate(context);

    // ---- 3. 下单意图：以第 i+1 根开盘价成交（下一迭代外推成交价）----
    if (output.action !== 'HOLD' && output.confidence >= config.minConfidence) {
      const nextOpen = candles[i + 1].open;
      const fillPrice =
        output.action === 'BUY' ? nextOpen * (1 + slippage) : nextOpen * (1 - slippage);

      // 仓位公式与实盘 execute() 一致：BUY 用 quote 资金比例，SELL 用 base 持仓比例
      const rawQty =
        output.action === 'BUY'
          ? (quoteFree * config.positionPct) / fillPrice
          : baseFree * config.positionPct;

      if (rawQty > 0) {
        const notional = rawQty * fillPrice;
        const fee = notional * feeRate;
        const slippageCost = Math.abs(fillPrice - nextOpen) * rawQty;

        if (output.action === 'BUY') {
          quoteFree -= notional + fee;
          baseFree += rawQty;
        } else {
          baseFree -= rawQty;
          quoteFree += notional - fee;
        }

        fills.push({
          side: output.action,
          quantity: rawQty,
          price: fillPrice,
          fee,
        } satisfies PositionFill);
        trades.push({
          time: candles[i + 1].time,
          side: output.action,
          price: Number(fillPrice.toFixed(2)),
          quantity: rawQty,
          fee: Number(fee.toFixed(4)),
          slippageCost: Number(slippageCost.toFixed(4)),
          equityAfter: 0, // 回填于权益点计算后
          decisionConfidence: output.confidence,
          indicatorScore,
        });
      }
    }

    // ---- 4. 记录权益点（权益 = 现金 + 持仓市值，按本根收盘估值）----
    const positionNow = computePosition(config.symbol, fills, candles[i].close);
    const equity = quoteFree + positionNow.quantity * candles[i].close;
    equityCurve.push({
      time: candles[i].time,
      equity: Number(equity.toFixed(2)),
      drawdownPct: 0,
    });
  }

  // 权益点回撤与成交后权益回填
  let peak = -Infinity;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    point.drawdownPct = peak > 0 ? Number((((peak - point.equity) / peak) * 100).toFixed(2)) : 0;
  }
  let tradeCursor = 0;
  for (const point of equityCurve) {
    while (tradeCursor < trades.length && trades[tradeCursor].time <= point.time) {
      trades[tradeCursor].equityAfter = point.equity;
      tradeCursor++;
    }
  }

  const metrics = computeMetrics({
    equityCurve,
    trades,
    initialCapital: config.initialCapital,
    interval: config.interval,
    firstClose: candles[Math.min(config.warmupBars, candles.length - 1)].close,
    lastClose: candles.at(-1)!.close,
  });

  return {
    meta: {
      symbol: config.symbol,
      interval: config.interval,
      from: config.from,
      to: config.to,
      candleCount: candles.length,
      warmupBars: config.warmupBars,
      initialCapital: config.initialCapital,
      slippageBps: config.slippageBps,
      feeRateBps: config.feeRateBps,
      positionPct: config.positionPct,
      minConfidence: config.minConfidence,
      strategyName: strategy.name,
      strategyParams: strategy.normalizeParams(config.strategyParams),
      fillConvention: 'next-open',
    },
    metrics,
    equityCurve,
    trades,
  };
}

