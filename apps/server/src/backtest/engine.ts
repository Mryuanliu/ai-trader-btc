import {
  Candle,
  Strategy,
  StrategyContext,
  buildSignals,
  strategyRegistry,
  computeIndicators,
  computePosition,
  scoreSignals,
} from '@ai-trader/shared';
import type { PositionFill, PositionSnapshot } from '@ai-trader/shared';
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
/**
 * 回测主函数（纯计算、确定性不变）。
 * async + 分块让出事件循环：仅供 HTTP 服务运行时把进度回调与轮询请求调度进来，
 * CLI/测试场景传或不传 onProgress 结果完全一致。
 */
export async function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  config: BacktestConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<BacktestReport> {
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

  const totalBars = Math.max(1, candles.length - 1 - config.warmupBars);
  for (let i = config.warmupBars; i < candles.length - 1; i++) {
    // ---- 在第 i 根收盘时构造上下文并决策 ----
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const indicators = computeIndicators(window);
    // 按策略声明的 RSI 语义构造信号（B3），必须与实盘同口径，否则回测结论无效
    const signals = buildSignals(indicators, window, {
      rsiMode: strategyRegistry.rsiModeOf(config.strategyName),
    });
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

    // 出场规则（阶段 4）：优先级最高，触发时替代策略信号全仓卖出（与实盘 checkExitRules 同口径）
    const exit = checkExitTrigger(context.position, price, config.exitRules);
    const output = exit
      ? {
          action: 'SELL' as const,
          confidence: 1,
          reason: `出场规则触发：${exit}。按出场规则全仓卖出。`,
          exitFull: true,
        }
      : strategy.evaluate(context);

    // ---- 3. 下单意图：以第 i+1 根开盘价成交（下一迭代外推成交价）----
    if (output.action !== 'HOLD' && output.confidence >= config.minConfidence) {
      const nextOpen = candles[i + 1].open;
      const fillPrice =
        output.action === 'BUY' ? nextOpen * (1 + slippage) : nextOpen * (1 - slippage);

      // 仓位公式与实盘 execute() 一致：BUY 用 quote 资金比例，SELL 用 base 持仓比例
      const rawQty =
        output.action === 'BUY'
          ? (quoteFree * config.positionPct) / fillPrice
          : exit
            ? baseFree
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

    // 每 500 根报告一次进度并让出事件循环（确定性不受影响：只是调度，不改计算顺序）
    if (onProgress && (i - config.warmupBars) % 500 === 0) {
      onProgress(i - config.warmupBars, totalBars);
      await new Promise((resolve) => setImmediate(resolve));
    }
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
      exitRules: {
        stopLossPct: config.exitRules?.stopLossPct ?? null,
        takeProfitPct: config.exitRules?.takeProfitPct ?? null,
      },
      fillConvention: 'next-open',
    },
    metrics,
    equityCurve,
    trades,
  };
}

/**
 * 出场规则判定（与实盘 AgentEngine.checkExitRules 同口径）：
 * 持仓盈亏相对均价触及阈值时返回触发描述，无持仓/未配置返回 null。
 */
function checkExitTrigger(
  position: PositionSnapshot | null,
  price: number,
  rules?: BacktestConfig['exitRules'],
): string | null {
  const stop = rules?.stopLossPct ?? null;
  const take = rules?.takeProfitPct ?? null;
  if (stop == null && take == null) return null;
  if (!position || !(position.quantity > 0) || !(position.avgCost > 0)) return null;
  if (!(price > 0)) return null;

  const pnlPct = (price - position.avgCost) / position.avgCost;
  if (stop != null && pnlPct <= -stop) {
    return (
      `止损触发：现价 ${price.toFixed(2)} 较持仓均价 ${position.avgCost.toFixed(2)} ` +
      `亏损 ${(pnlPct * 100).toFixed(2)}%，达到 -${(stop * 100).toFixed(2)}% 阈值`
    );
  }
  if (take != null && pnlPct >= take) {
    return (
      `止盈触发：现价 ${price.toFixed(2)} 较持仓均价 ${position.avgCost.toFixed(2)} ` +
      `盈利 ${(pnlPct * 100).toFixed(2)}%，达到 +${(take * 100).toFixed(2)}% 阈值`
    );
  }
  return null;
}
