import {
  Candle,
  FuturesPositionState,
  Strategy,
  StrategyContext,
  buildSignals,
  computeIndicators,
  emptyFuturesPosition,
  applyFuturesFill,
  evaluateExitRules,
  floorToStep,
  isActionableIntent,
  resolveFuturesOrderIntent,
  scoreSignals,
} from '@ai-trader/shared';
import { computeFuturesMetrics } from './metrics';
import type {
  EquityPoint,
  FuturesBacktestConfig,
  FuturesBacktestReport,
  FuturesBacktestTrade,
  FuturesLiquidationEvent,
} from './types';

/**
 * 合约回测引擎：事件驱动回放 + 纯函数（与现货 runBacktest 同一套确定性约束）。
 *
 * 确定性：无随机源、无 Date.now()，同一输入连跑两次输出逐字节一致。
 * 成交口径：第 i 根收盘决策，以第 i+1 根开盘价成交（加滑点），无前视偏差。
 *
 * 资金模型（逐仓）：
 *   equity = cash + margin + netQty × (mark − entry)
 *   - 开仓：从 cash 划出保证金（= 名义 / 杠杆）与手续费
 *   - 平仓：保证金 + 已实现盈亏 − 手续费 回到 cash
 *   - 资金费：每 8h 按名义价值 × 费率结算，多头付正费率，空头收正费率
 *   - 强平（简化保守模型）：逐仓下价格触及 entry ∓ margin/|qty| 即全损保证金，
 *     用 K 线高低价判定触碰（多头看 low，空头看 high），先于出场规则与决策
 *
 * 简化声明（相对实盘的偏差，回测结果按保守方向读取）：
 *   - 不建模维持保证金率分档与 ADL，强平价即「保证金亏完」
 *   - 资金费按本根收盘的名义价值估算，非结算时点的精确标记价
 */
export async function runFuturesBacktest(
  candles: Candle[],
  strategy: Strategy,
  config: FuturesBacktestConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<FuturesBacktestReport> {
  const WINDOW = 200;
  const slippage = config.slippageBps / 10_000;
  const feeRate = config.feeRateBps / 10_000;
  const leverage = Math.min(10, Math.max(1, Math.round(config.leverage)));

  // 钱包现金（未占用部分）；margin 是仓位锁定的逐仓保证金
  let cash = config.initialCapital;
  let margin = 0;
  let pos: FuturesPositionState = emptyFuturesPosition(config.symbol);

  const trades: FuturesBacktestTrade[] = [];
  const liquidations: FuturesLiquidationEvent[] = [];
  let totalFundingPaid = 0;
  let fundingCursor = 0;
  const fundingRates = config.fundingRates ?? [];

  const equityCurve: EquityPoint[] = [
    { time: candles[0]?.time ?? 0, equity: config.initialCapital, drawdownPct: 0 },
  ];

  const unrealized = (mark: number) =>
    pos.netQty !== 0 && mark > 0 ? pos.netQty * (mark - pos.entryPrice) : 0;

  /** 强平价：逐仓下保证金亏完的价格。无持仓返回 null */
  const liquidationPrice = (): number | null => {
    if (pos.netQty === 0 || !(pos.entryPrice > 0) || margin <= 0) return null;
    // 多头：entry − margin/qty（价格跌到这里保证金亏完）；空头：entry + margin/|qty|
    return pos.netQty > 0
      ? pos.entryPrice - margin / pos.netQty
      : pos.entryPrice + margin / Math.abs(pos.netQty);
  };

  const totalBars = Math.max(1, candles.length - 1 - config.warmupBars);
  for (let i = config.warmupBars; i < candles.length - 1; i++) {
    const bar = candles[i];

    // ---- 1. 强平检查（保守：先于资金费、出场与决策）----
    const liq = liquidationPrice();
    if (liq !== null) {
      const touched =
        pos.netQty > 0 ? bar.low <= liq : bar.high >= liq;
      if (touched) {
        liquidations.push({
          time: bar.time,
          price: Number(liq.toFixed(2)),
          loss: Number(margin.toFixed(2)),
          positionSide: pos.netQty > 0 ? 'LONG' : 'SHORT',
          quantity: Math.abs(pos.netQty),
        });
        // 逐仓：保证金全部损失，现金不受影响（保证金开仓时已划出）
        cash += 0;
        margin = 0;
        pos = emptyFuturesPosition(config.symbol);
      }
    }

    // ---- 2. 资金费结算：结算时点落在 (上一根开盘, 本根时间] 的区间内 ----
    // 先跳过早于回测起点/上一根的历史结算点，否则指针会被第一个过期点卡死
    while (
      fundingCursor < fundingRates.length &&
      fundingRates[fundingCursor].fundingTime <= candles[i - 1].time
    ) {
      fundingCursor += 1;
    }
    const notionalNow = Math.abs(pos.netQty) * bar.open;
    while (
      fundingCursor < fundingRates.length &&
      fundingRates[fundingCursor].fundingTime <= bar.time
    ) {
      const fr = fundingRates[fundingCursor];
      // 多头付正费率；空头收正费率（净持仓为负时支付额取反）
      const payment = notionalNow * fr.rate * Math.sign(pos.netQty || 0);
      cash -= payment;
      totalFundingPaid += payment;
      fundingCursor += 1;
    }

    // ---- 3. 第 i 根收盘决策 ----
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const indicators = computeIndicators(window);
    const signals = buildSignals(indicators, window);
    const indicatorScore = scoreSignals(signals);
    const price = bar.close;

    // 合约仓位映射为策略上下文：数量取绝对值（方向由执行层结合净持仓正负决定）
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
        ts: price > 0 ? bar.time : 0,
      },
      position: {
        symbol: config.symbol,
        quantity: Math.abs(pos.netQty),
        avgCost: pos.entryPrice,
        realizedPnl: pos.realizedPnl,
        unrealizedPnl: unrealized(price),
        marketValue: Math.abs(pos.netQty) * price,
        totalBought: 0,
        totalSold: 0,
        totalFee: pos.totalFee,
      },
      // 合约账户语义：quoteFree=可用保证金，baseFree=当前净持仓绝对值
      account: { quoteFree: cash, baseFree: Math.abs(pos.netQty) },
      params: strategy.normalizeParams(config.strategyParams),
    };

    // 出场规则（方向感知）优先级最高；触发时替代策略信号全平
    const exit = evaluateExitRules({
      entryPrice: pos.entryPrice,
      price,
      side: pos.netQty > 0 ? 'LONG' : pos.netQty < 0 ? 'SHORT' : null,
      exitRules: {
        stopLossPct: config.exitRules?.stopLossPct ?? null,
        takeProfitPct: config.exitRules?.takeProfitPct ?? null,
      },
    });
    const output = exit.triggered && exit.closeAction
      ? {
          action: exit.closeAction,
          confidence: 1,
          reason: `出场规则触发：${exit.reason}。按出场规则全部平仓。`,
        }
      : strategy.evaluate(context);

    // ---- 4. 下单意图：策略动作 + 净持仓 → 开/加/平（与实盘同源）----
    if (output.action !== 'HOLD' && output.confidence >= config.minConfidence) {
      const intent = resolveFuturesOrderIntent(output.action, pos.netQty);
      // 类型守卫收窄：HOLD 无 side，开/平三分支才有
      if (isActionableIntent(intent)) {
      const nextOpen = candles[i + 1].open;
      const fillPrice =
        intent.side === 'BUY' ? nextOpen * (1 + slippage) : nextOpen * (1 - slippage);

      if (intent.kind === 'close') {
        // 平仓：全平净持仓（反手信号只平不反，下一周期自然开反向）
        const closeQty = Math.abs(pos.netQty);
        if (closeQty > 0) {
          const notional = closeQty * fillPrice;
          const fee = notional * feeRate;
          const realized = pos.netQty * (fillPrice - pos.entryPrice);
          cash += margin + realized - fee;
          pushTrade(candles[i + 1].time, intent.side, fillPrice, closeQty, fee, nextOpen, output.confidence, indicatorScore, pos.netQty > 0 ? 'LONG' : 'SHORT', true, 0, notional);
          margin = 0;
          pos = emptyFuturesPosition(config.symbol);
        }
      } else if (intent.kind === 'open' || intent.kind === 'add') {
        // 开仓/加仓：保证金预算 = 可用现金 × positionPct，名义 = 保证金 × 杠杆
        const marginBudget = cash * config.positionPct;
        const rawQty = marginBudget * leverage > 0
          ? floorToStep((marginBudget * leverage) / fillPrice, config.stepSize)
          : 0;
        const notional = rawQty * fillPrice;

        if (rawQty > 0 && notional >= config.minNotional) {
          const usedMargin = notional / leverage;
          const fee = notional * feeRate;
          if (usedMargin + fee <= cash) {
            cash -= usedMargin + fee;
            margin += usedMargin;
            pos = applyFuturesFill(pos, { side: intent.side, quantity: rawQty, price: fillPrice, fee: 0 });
            pushTrade(
              candles[i + 1].time, intent.side, fillPrice, rawQty, fee, nextOpen,
              output.confidence, indicatorScore, intent.positionSide, false, usedMargin, notional,
            );
          }
        }
      }
      }
    }

    // ---- 5. 权益点（本根收盘估值）----
    const equity = cash + margin + unrealized(bar.close);
    equityCurve.push({
      time: bar.time,
      equity: Number(equity.toFixed(2)),
      drawdownPct: 0,
    });

    if (onProgress && (i - config.warmupBars) % 500 === 0) {
      onProgress(i - config.warmupBars, totalBars);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // 权益点回撤回填
  let peak = -Infinity;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    point.drawdownPct = peak > 0 ? Number((((peak - point.equity) / peak) * 100).toFixed(2)) : 0;
  }
  // 成交后权益回填
  let tradeCursor = 0;
  for (const point of equityCurve) {
    while (tradeCursor < trades.length && trades[tradeCursor].time <= point.time) {
      trades[tradeCursor].equityAfter = point.equity;
      tradeCursor++;
    }
  }

  const metrics = computeFuturesMetrics({
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
      minConfidence: config.minConfidence,
      strategyName: strategy.name,
      strategyParams: strategy.normalizeParams(config.strategyParams),
      exitRules: {
        stopLossPct: config.exitRules?.stopLossPct ?? null,
        takeProfitPct: config.exitRules?.takeProfitPct ?? null,
      },
      fillConvention: 'next-open',
      leverage,
      stepSize: config.stepSize,
      minNotional: config.minNotional,
      totalFundingPaid: Number(totalFundingPaid.toFixed(4)),
      liquidationCount: liquidations.length,
    },
    metrics,
    equityCurve,
    trades,
    liquidations,
  };

  function pushTrade(
    time: number,
    side: 'BUY' | 'SELL',
    price: number,
    quantity: number,
    fee: number,
    rawOpen: number,
    confidence: number,
    indicatorScore: number,
    positionSide: 'LONG' | 'SHORT',
    reduceOnly: boolean,
    usedMargin: number,
    notional: number,
  ) {
    trades.push({
      time,
      side,
      price: Number(price.toFixed(2)),
      quantity,
      fee: Number(fee.toFixed(4)),
      slippageCost: Number((Math.abs(price - rawOpen) * quantity).toFixed(4)),
      equityAfter: 0,
      decisionConfidence: confidence,
      indicatorScore,
      positionSide,
      reduceOnly,
      margin: Number(usedMargin.toFixed(2)),
      notional: Number(notional.toFixed(2)),
    });
  }
}
