import {
  atr,
  computePerformance,
  TIMEFRAME_MS,
  type Candle,
  type BacktestConfig,
  type BacktestMetrics,
  type BacktestReport,
  type BacktestResult,
  type EquityPoint,
} from '@ai-trader/shared';
import type { DataSource } from 'typeorm';
import type { StrategyContext, TradingStrategy } from '../../strategy/types';
import { EventBroker } from './event-broker';
import { loadMarketEvents } from './events-feed';
import { ENGINE_VERSION_V1, type EngineStats } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** ctx 窗口基础值；策略可用 contextCandles 声明抬高（与 vectorized/实盘 runner 同规则） */
const CONTEXT_LOOKBACK = 300;

function computeAtr(candles: Candle[]): number {
  if (candles.length < 20) return 0;
  const v = atr(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    candles.map((c) => c.close),
    14,
  );
  return Number.isFinite(v) ? v : 0;
}

export interface EventDrivenRunOptions {
  ds: DataSource;
  strategy: TradingStrategy;
  /** 复用 vectorized 的 BacktestConfig（字段一致；额外通过 engineMeta 记录版本） */
  config: BacktestConfig;
  /** 预加载 K 线（walk-forward 切窗用；缺省时从 DB 读 market_candles） */
  candles?: Candle[];
  /** 无 aggTrade 时是否允许 bar 粒度降级（默认 false） */
  allowBarFallback?: boolean;
  /** 维持保证金率（默认 0.005 = 0.5%） */
  maintMarginRatio?: number;
}

export interface EventDrivenRunResult extends BacktestResult {
  engineStats: EngineStats;
  engineVersion: string;
}

/**
 * event-driven-v1 引擎主入口。
 *
 * 与 vectorized runBacktestOnCandles 的关键区别（保真度）：
 * 1. 事件流 = merge(aggTrades, markPrices, fundingSettlements, barClose) 按 ts 归并
 * 2. 市价成交用**下一笔 aggTrade**（不再是下根 bar.open）——真 latency
 * 3. STOP 逐笔检查（不再每 bar 单次）——根除 intrabar 漏触发
 * 4. funding 按 8h 结算事件精确入账（rate × mark × |qty|）——不再按 bar 时长分摊
 * 5. markPrice 独立于 close；每次 mark tick 检查强平
 *
 * 待 P1b 补：L2 队列/VWAP/冲击/latency 20ms。当前 fillConvention 明确写 `event-driven-v1`
 * 与 vectorized 的 `next-open` 区分，避免混用报告。
 */
export async function runBacktestEventDriven(
  opts: EventDrivenRunOptions,
): Promise<EventDrivenRunResult> {
  const { ds, strategy, config } = opts;
  const intervalMs = TIMEFRAME_MS[config.interval];
  const instanceId = `${config.strategyName}:${config.symbol}`;

  const { events, candles, stats } = await loadMarketEvents({
    ds,
    symbol: config.symbol,
    interval: config.interval,
    from: config.from,
    to: config.to,
    candles: opts.candles,
    allowBarFallback: opts.allowBarFallback,
  });

  if (candles.length <= config.warmupBars) {
    throw new Error(`K 线仅 ${candles.length} 根，不足以预热 ${config.warmupBars} 根`);
  }

  const params = strategy.normalizeParams(config.params ?? {});
  strategy.onStart?.(params, instanceId);

  const broker = new EventBroker({
    symbol: config.symbol,
    instanceId,
    initialCapital: config.initialCapital,
    feeRate: config.feeRateBps / 10_000,
    slippage: config.slippageBps / 10_000,
    maintMarginRatio: opts.maintMarginRatio ?? 0.005,
  });

  // 用于 onTick 构造 ctx 的 bar 历史窗口（每根 bar 收盘时推入）；上限同实盘按策略声明抬高
  const contextLookback = Math.max(CONTEXT_LOOKBACK, strategy.contextCandles ?? 0);
  const barHistory: Candle[] = [];
  const equityCurve: EquityPoint[] = [];
  let peak = config.initialCapital;
  let maxDrawdownPct = 0;
  let barsProcessed = 0;
  let stopTriggers = 0;
  let liquidations = 0;
  let fills = 0;

  for (const ev of events) {
    const r = broker.applyEvent(ev);
    fills += r.fills;
    stopTriggers += r.stopTriggers;
    liquidations += r.liquidations;

    if (ev.kind !== 'bar') continue;

    barsProcessed += 1;
    barHistory.push(ev.bar);
    if (barHistory.length > contextLookback) barHistory.shift();

    const mark = broker.prices().mark || ev.bar.close;
    if (barsProcessed > config.warmupBars) {
      const ctx: StrategyContext = {
        instanceId,
        symbol: config.symbol,
        price: broker.prices().last || ev.bar.close,
        markPrice: mark,
        atr: computeAtr(barHistory),
        candles: barHistory.slice(),
        openLots: broker.lotViews(mark),
        openOrders: broker.orderViews(),
        availableMargin: broker.equity(mark),
        // 回测无独立钱包口径：equity 即真实权益（与 availableMargin 同值）
        walletBalance: broker.equity(mark),
        netQty: broker.netQty(),
        params,
        now: ev.bar.time + intervalMs,
      };
      await strategy.onTick(ctx, broker);
    }

    const equity = broker.equity(mark);
    peak = Math.max(peak, equity);
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
    equityCurve.push({
      time: ev.bar.time,
      equity: Number(equity.toFixed(8)),
      drawdownPct: Number(ddPct.toFixed(4)),
    });
  }

  const finalBar = candles[candles.length - 1];
  const finalMark = broker.prices().mark || finalBar.close;
  const finalEquity = broker.equity(finalMark);
  const { rounds, costs } = broker.finalize();
  const basketMetrics = computePerformance(config.strategyName, config.symbol, 'all', rounds);

  const firstClose = candles[config.warmupBars]?.close ?? candles[0].close;
  const buyHoldReturnPct = ((finalMark - firstClose) / firstClose) * 100;
  const totalReturnPct = ((finalEquity - config.initialCapital) / config.initialCapital) * 100;
  const spanMs = finalBar.time - candles[config.warmupBars].time;
  const spanDays = Math.max(1, spanMs / DAY_MS);
  const annualizedReturnPct =
    finalEquity > 0
      ? (Math.pow(finalEquity / config.initialCapital, 365 / spanDays) - 1) * 100
      : -100;

  const openFillCount = broker.trades.filter((t) => t.kind === 'OPEN').length;
  const metrics: BacktestMetrics = {
    totalReturnPct: Number(totalReturnPct.toFixed(4)),
    annualizedReturnPct: Number(annualizedReturnPct.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    sharpeRatio: basketMetrics.sharpe,
    winRate: basketMetrics.winRate,
    profitFactor: basketMetrics.profitFactor,
    tradeCount: openFillCount,
    buyHoldReturnPct: Number(buyHoldReturnPct.toFixed(4)),
    excessVsBuyHoldPct: Number((totalReturnPct - buyHoldReturnPct).toFixed(4)),
  };

  const report: BacktestReport = {
    meta: {
      symbol: config.symbol,
      interval: config.interval,
      from: candles[0].time,
      to: finalBar.time,
      candleCount: candles.length,
      warmupBars: config.warmupBars,
      initialCapital: config.initialCapital,
      slippageBps: config.slippageBps,
      feeRateBps: config.feeRateBps,
      fundingPctPer8h: config.fundingPctPer8h,
      strategyName: config.strategyName,
      strategyParams: params,
      fillConvention: 'event-driven-v1',
      generatedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION_V1,
    },
    metrics,
    basketMetrics,
    costBreakdown: costs,
    equityCurve,
    trades: broker.trades,
  };

  strategy.onStop?.(instanceId);

  return {
    candles,
    config,
    report,
    rounds,
    engineVersion: ENGINE_VERSION_V1,
    engineStats: {
      aggTradeCount: stats.aggTradeCount,
      markPriceCount: stats.markPriceCount,
      fundingEvents: stats.fundingEvents,
      barsProcessed,
      stopTriggers,
      liquidations,
    },
  };
}

/** 让上层可观测 fills（不进 BacktestMetrics，仅诊断用） */
export function _diagFillCount(r: EventDrivenRunResult): number {
  return r.report.trades.length;
}
