import {
  Candle,
  FuturesPositionState,
  Strategy,
  StrategyContext,
  buildSignals,
  strategyRegistry,
  computeIndicators,
  checkLotExit,
  floorToStep,
  settleLotPnl,
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
 *
 * Lot 模型（2026-08-31 起，与实盘 FuturesEngine 同口径）：
 *   BUY 恒开多 Lot、SELL 恒开空 Lot，多空 Lot 可共存（hedge 锁仓）；
 *   出场只有逐单止盈止损（checkLotExit，每 Lot 自己的 entryPrice/TP/SL）；
 *   不再有「反手平仓」语义——反向信号只是开反向新 Lot，不碰旧仓。
 *   强平按 Lot 逐仓判定：单笔 Lot 保证金亏完即平掉该 Lot（不影响其他 Lot）。
 */

/** 合约回测 Lot（订单级仓位单）：与实盘 PositionLot 同口径 */
interface FuturesBacktestLot {
  id: number;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  margin: number;
  entryFee: number;
  stopLossPct: number;
  takeProfitPct: number;
}
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

  // 钱包现金（未占用部分）；每个 Lot 锁定自己的逐仓保证金
  let cash = config.initialCapital;
  let lotSeq = 0;
  const lots: FuturesBacktestLot[] = [];

  const trades: FuturesBacktestTrade[] = [];
  const liquidations: FuturesLiquidationEvent[] = [];
  let totalFundingPaid = 0;
  let fundingCursor = 0;
  const fundingRates = config.fundingRates ?? [];

  const equityCurve: EquityPoint[] = [
    { time: candles[0]?.time ?? 0, equity: config.initialCapital, drawdownPct: 0 },
  ];

  // 净持仓视图（风控/上下文用）：多头量 − 空头量
  const netQty = () => lots.reduce((acc, l) => acc + (l.direction === 'LONG' ? l.quantity : -l.quantity), 0);
  const totalMargin = () => lots.reduce((acc, l) => acc + l.margin, 0);
  // 总浮动盈亏（所有未完结 Lot 按 mark 计）
  const unrealized = (mark: number) =>
    lots.reduce((acc, l) => acc + (l.direction === 'LONG' ? 1 : -1) * (mark - l.entryPrice) * l.quantity, 0);
  // 加权平均入场价（净持仓视角）
  const avgEntry = () => {
    const nq = netQty();
    if (nq === 0) return 0;
    return (
      lots.reduce((acc, l) => acc + (l.direction === 'LONG' ? 1 : -1) * l.entryPrice * l.quantity, 0) / Math.abs(nq)
    );
  };
  // 净持仓已实现盈亏（资金费在 cash 侧记，这里累计平仓盈亏用于上下文展示）
  let realizedTotal = 0;

  const totalBars = Math.max(1, candles.length - 1 - config.warmupBars);
  for (let i = config.warmupBars; i < candles.length - 1; i++) {
    const bar = candles[i];

    // ---- 1. 逐 Lot 强平检查（保守：先于资金费、出场与决策）----
    // 每个 Lot 有独立保证金与入场价：多头看 low、空头看 high 是否触及其强平价
    for (let li = lots.length - 1; li >= 0; li--) {
      const lot = lots[li];
      const liqPrice =
        lot.direction === 'LONG'
          ? lot.entryPrice - lot.margin / lot.quantity
          : lot.entryPrice + lot.margin / lot.quantity;
      const touched = lot.direction === 'LONG' ? bar.low <= liqPrice : bar.high >= liqPrice;
      if (touched) {
        liquidations.push({
          time: bar.time,
          price: Number(liqPrice.toFixed(2)),
          loss: Number(lot.margin.toFixed(2)),
          positionSide: lot.direction,
          quantity: lot.quantity,
        });
        // 逐仓：该 Lot 保证金全部损失；现金不受影响（保证金开仓时已划出）
        lots.splice(li, 1);
      }
    }

    // ---- 2. 资金费结算：结算时点落在 (上一根开盘, 本根时间] 的区间内 ----
    // 按净持仓（多头量 − 空头量）计：锁仓时多空对冲，净资金费趋于 0，与实盘一致
    while (
      fundingCursor < fundingRates.length &&
      fundingRates[fundingCursor].fundingTime <= candles[i - 1].time
    ) {
      fundingCursor += 1;
    }
    const net = netQty();
    const notionalNow = Math.abs(net) * bar.open;
    while (
      fundingCursor < fundingRates.length &&
      fundingRates[fundingCursor].fundingTime <= bar.time
    ) {
      const fr = fundingRates[fundingCursor];
      // 净多头付正费率；净空头收正费率
      const payment = notionalNow * fr.rate * Math.sign(net || 0);
      cash -= payment;
      totalFundingPaid += payment;
      fundingCursor += 1;
    }

    // ---- 3. 第 i 根收盘决策 ----
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const indicators = computeIndicators(window);
    // 按策略声明的 RSI 语义构造信号（B3），与现货回测、实盘保持同口径
    const signals = buildSignals(indicators, window, {
      rsiMode: strategyRegistry.rsiModeOf(config.strategyName),
    });
    const indicatorScore = scoreSignals(signals);
    const price = bar.close;

    const nq = netQty();
    const nqAbs = Math.abs(nq);
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
        quantity: nqAbs,
        avgCost: avgEntry(),
        realizedPnl: realizedTotal,
        unrealizedPnl: unrealized(price),
        marketValue: nqAbs * price,
        totalBought: 0,
        totalSold: 0,
        totalFee: 0,
      },
      // 合约账户语义：quoteFree=可用保证金，baseFree=当前净持仓绝对值
      account: { quoteFree: cash, baseFree: nqAbs },
      params: strategy.normalizeParams(config.strategyParams),
    };

    // ---- 3. 出场优先：逐 Lot 止盈止损（Lot 模型下唯一自动出场，与实盘 checkLotExit 同口径）----
    // 第 i 根收盘判定 → 第 i+1 根开盘成交；先平全部触发 Lot，不再开新仓
    const nextOpen = candles[i + 1].open;
    const triggered = lots.filter((lot) =>
      checkLotExit({
        entryPrice: lot.entryPrice,
        direction: lot.direction,
        stopLossPct: lot.stopLossPct,
        takeProfitPct: lot.takeProfitPct,
        price,
      }),
    );
    for (const lot of triggered) {
      const closeSide = lot.direction === 'LONG' ? 'SELL' : 'BUY';
      const fillPrice = closeSide === 'BUY' ? nextOpen * (1 + slippage) : nextOpen * (1 - slippage);
      const notional = lot.quantity * fillPrice;
      const exitFee = notional * feeRate;
      const { realizedPnl } = settleLotPnl({
        direction: lot.direction,
        quantity: lot.quantity,
        entryPrice: lot.entryPrice,
        exitPrice: fillPrice,
        entryFee: lot.entryFee,
        exitFee,
      });
      // 逐仓：本金（保证金）退回 + 已实现盈亏 − 平仓费
      cash += lot.margin + realizedPnl - exitFee;
      realizedTotal += realizedPnl;
      pushTrade(
        candles[i + 1].time, closeSide, fillPrice, lot.quantity, exitFee, nextOpen,
        1, indicatorScore, lot.direction, true, lot.margin, notional,
      );
      lots.splice(lots.indexOf(lot), 1);
    }

    if (triggered.length === 0) {
      // 无 Lot 触发 → 策略信号只负责开新仓（BUY 恒开多 / SELL 恒开空，多空可共存）
      const output = strategy.evaluate(context);
      if (output.action !== 'HOLD' && output.confidence >= config.minConfidence) {
        // Lot 语义：动作直接映射方向，与净持仓无关
        const direction: 'LONG' | 'SHORT' = output.action === 'BUY' ? 'LONG' : 'SHORT';
        const side = output.action === 'BUY' ? 'BUY' : 'SELL';
        const fillPrice = side === 'BUY' ? nextOpen * (1 + slippage) : nextOpen * (1 - slippage);

        // 开仓：保证金预算 = 可用现金 × positionPct，名义 = 保证金 × 杠杆
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
            lots.push({
              id: ++lotSeq,
              direction,
              quantity: rawQty,
              entryPrice: fillPrice,
              margin: usedMargin,
              entryFee: fee,
              stopLossPct: config.exitRules?.stopLossPct ?? 0.02,
              takeProfitPct: config.exitRules?.takeProfitPct ?? 0.04,
            });
            pushTrade(
              candles[i + 1].time, side, fillPrice, rawQty, fee, nextOpen,
              output.confidence, indicatorScore, direction, false, usedMargin, notional,
            );
          }
        }
      }
    }

    // ---- 5. 权益点（本根收盘估值：现金 + 所有 Lot 保证金 + 净持仓浮动盈亏）----
    const equity = cash + totalMargin() + unrealized(bar.close);
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
