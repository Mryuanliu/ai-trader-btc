/**
 * 回测 CLI（`pnpm --filter @ai-trader/server backtest -- --strategy trend_following ...`）。
 *
 * 直接 `new` 出策略 + SimBroker 跑历史回放，**不接 DB / 交易所 / Nest**，
 * 跑完把报告写到 reports/backtest/*.json 并打印摘要。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  FUTURES_TAKER_FEE_RATE,
  TIMEFRAMES,
  TIMEFRAME_MS,
  type BacktestConfig,
  type Timeframe,
} from '@ai-trader/shared';
import { runBacktest, runBacktestOnCandles } from './backtest-runner';
import { loadHistoricalCandles } from './historical-feed';
import { availableStrategies, createStrategy } from './strategy-registry';
import { walkForward } from './research/walk-forward';
import { cpcv } from './research/cpcv';
import { runSweep } from './research/sweep';
import { deflatedSharpe } from './research/deflated-sharpe';
import { perBarReturns, sharpePerBar } from './research/stats';
import { lookaheadCheck } from './research/lookahead-check';
import { blockBootstrapMaxDD } from './research/monte-carlo';
import {
  aggregateDailyCloses,
  classifyDailyRegimes,
  regimeSummary,
  timedReturnsFromEquity,
} from './research/regime';
import type { Candle, MonteCarloResult, RegimeSummary as RegimeSummaryT } from '@ai-trader/shared';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/** 数字或日期字符串 → 毫秒 */
function toMs(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${v}`);
  return t;
}

/** 封装一组 research（同 walk-forward/CPCV/DSR/lookahead），给 --compare 复用 */
interface ResearchBundle {
  whole: Awaited<ReturnType<typeof runBacktestOnCandles>>;
  wf: Awaited<ReturnType<typeof walkForward>>;
  cv: Awaited<ReturnType<typeof cpcv>>;
  la: Awaited<ReturnType<typeof lookaheadCheck>>;
  dsr: ReturnType<typeof deflatedSharpe>;
  mc?: MonteCarloResult;
  regime?: RegimeSummaryT;
}

async function runResearchOnce(
  strategyName: string,
  config: BacktestConfig,
  candles: Candle[],
  trainBars: number,
  testBars: number,
  stepBars: number | undefined,
  cpcvK: number,
  cpcvSize: number,
): Promise<ResearchBundle> {
  const whole = await runBacktestOnCandles(createStrategy(strategyName), { ...config }, candles);
  const wf = await walkForward(strategyName, config, candles, { trainBars, testBars, stepBars });
  const cv = await cpcv(strategyName, config, candles, { nFoldK: cpcvK, testFoldSize: cpcvSize });
  const la = await lookaheadCheck(strategyName, config, candles);
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[config.interval];
  const obsReturns = perBarReturns(wf.oosEquity.map((p) => p.equity));
  const trialSharpes = wf.segments.map((s) => s.oosSharpe / Math.sqrt(barsPerYear));
  const dsr = deflatedSharpe({
    obsSharpe: sharpePerBar(obsReturns),
    trialSharpes,
    obsReturns,
  });
  // A6 v2 二次度量：Monte Carlo 回撤分布 + regime 分层（与 service 同口径）
  const mc = obsReturns.length >= 4 ? blockBootstrapMaxDD(obsReturns, {}) : undefined;
  let regime: RegimeSummaryT | undefined;
  try {
    const byDay = classifyDailyRegimes(aggregateDailyCloses(candles), {});
    if (byDay.size > 0) {
      const s = regimeSummary(timedReturnsFromEquity(wf.oosEquity), byDay, config.interval);
      if (s.classifiedBars > 0) regime = s;
    }
  } catch {
    regime = undefined;
  }
  return { whole, wf, cv, la, dsr, mc, regime };
}

/** 将一份 ResearchBundle 缩写成一行文本（--compare 日志展示） */
function briefLine(tag: string, b: ResearchBundle): string {
  return [
    `[${tag}]`,
    `aggOOS=${b.wf.aggregateOosSharpe}`,
    `aggIS=${b.wf.aggregateIsSharpe}`,
    `oosRet=${b.wf.oosTotalReturnPct}%`,
    `oosMaxDD=${b.wf.oosMaxDrawdownPct}%`,
    `trades=${b.wf.oosTradeCount}`,
    `dsr=${b.dsr.dsr}(passed=${b.dsr.passed})`,
  ].join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const strategyName = args.strategy ?? 'trend_following';
  if (!availableStrategies().includes(strategyName)) {
    throw new Error(
      `未知策略：${strategyName}（可选：${availableStrategies().join(', ')}）`,
    );
  }
  const interval = (args.interval ?? '5m') as Timeframe;
  if (!(TIMEFRAMES as readonly string[]).includes(interval)) {
    throw new Error(`非法周期：${interval}（可选：${TIMEFRAMES.join(', ')}）`);
  }

  const config: BacktestConfig = {
    symbol: (args.symbol ?? 'BTCUSDT').toUpperCase(),
    interval,
    from: args.from ? toMs(args.from) : undefined,
    to: args.to ? toMs(args.to) : undefined,
    initialCapital: args.initial ? Number(args.initial) : 10_000,
    warmupBars: args.warmup ? Number(args.warmup) : 120,
    feeRateBps: args['fee-bps'] ? Number(args['fee-bps']) : Math.round(FUTURES_TAKER_FEE_RATE * 10_000),
    slippageBps: args['slip-bps'] ? Number(args['slip-bps']) : 5,
    fundingPctPer8h: args.funding ? Number(args.funding) : 0,
    strategyName,
    params: args.params ? JSON.parse(args.params) : args.config ? JSON.parse(args.config) : undefined,
    file: args.file,
    cacheDir: args['cache-dir'] ?? 'reports/backtest/data',
  };

  const mode = (args.mode ?? 'single').toLowerCase();

  // —— 可选 DB 源：--source db 时 K 线优先从 market_candles 离线读（多年 1m 归档灌库后） ——
  let dataSource: import('typeorm').DataSource | undefined;
  if (args.source === 'db') {
    const { AppDataSource } = await import('../database/data-source');
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    dataSource = AppDataSource;
  }

  // —— event-driven-v1：从 DB 读 aggTrades/markPrice/funding，逐笔撮合 ——
  if (mode === 'event-driven' || mode === 'event') {
    const { withDataSource } = await import('./pull/history-pull');
    const { runBacktestEventDriven } = await import('./event-driven/runner');
    // 预加载 K 线（与 vectorized 同数据源，避免 DB 没同步 market_candles）
    const edCandles = await loadHistoricalCandles({
      symbol: config.symbol,
      interval: config.interval,
      from: config.from,
      to: config.to,
      file: config.file,
      cacheDir: config.cacheDir,
      dataSource,
    });
    const outFile =
      args.out ??
      join(
        'reports/backtest',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}-event-driven.json`,
      );
    mkdirSync(dirname(outFile), { recursive: true });
    const result = await withDataSource((ds) =>
      runBacktestEventDriven({
        ds,
        strategy: createStrategy(strategyName),
        config,
        candles: edCandles,
        allowBarFallback: args['allow-bar-fallback'] === 'true',
        maintMarginRatio: args['mmr'] ? Number(args['mmr']) : undefined,
      }),
    );
    writeFileSync(outFile, JSON.stringify(result.report, null, 2));
    const m = result.report.metrics;
    const s = result.engineStats;
    // eslint-disable-next-line no-console
    console.log(
      [
        `event-driven-v1 ${strategyName} @ ${config.symbol} ${config.interval}（${config.from}~${config.to}）`,
        `事件流：aggTrades=${s.aggTradeCount} markPrice=${s.markPriceCount} funding=${s.fundingEvents} bars=${s.barsProcessed}`,
        `撮合：openFills=${m.tradeCount} stopTriggers=${s.stopTriggers} liquidations=${s.liquidations}`,
        `费后总收益 ${m.totalReturnPct}% | 年化 ${m.annualizedReturnPct}% | 回撤 ${m.maxDrawdownPct}%`,
        `夏普 ${m.sharpeRatio} | 胜率 ${m.winRate} | 盈亏比 ${m.profitFactor}`,
        `买入持有 ${m.buyHoldReturnPct}% | 超额 ${m.excessVsBuyHoldPct}%`,
        `费用 ${result.report.costBreakdown.totalFees}U | 滑点 ${result.report.costBreakdown.totalSlippage}U | 资金费 ${result.report.costBreakdown.totalFunding}U`,
        `报告 → ${outFile}`,
      ].join('\n'),
    );
    return;
  }

  if (mode === 'single') {
    const result = await runBacktest(createStrategy(strategyName), config, dataSource);
    const { report } = result;
    const outFile =
      args.out ??
      join(
        'reports/backtest',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}.json`,
      );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(report, null, 2));

    const m = report.metrics;
    // eslint-disable-next-line no-console
    console.log(
      [
        `回测完成 ${strategyName} @ ${config.symbol} ${config.interval}（${report.meta.candleCount} 根，预热 ${config.warmupBars}）`,
        `费后总收益 ${m.totalReturnPct}% | 年化 ${m.annualizedReturnPct}% | 最大回撤 ${m.maxDrawdownPct}%`,
        `夏普 ${m.sharpeRatio} | 胜率 ${m.winRate} | 盈亏比 ${m.profitFactor} | 开仓笔数 ${m.tradeCount}`,
        `买入持有 ${m.buyHoldReturnPct}% | 超额 ${m.excessVsBuyHoldPct}%`,
        `费用合计 ${report.costBreakdown.totalFees}U | 滑点 ${report.costBreakdown.totalSlippage}U`,
        `报告 → ${outFile}`,
      ].join('\n'),
    );
    return;
  }

  if (mode !== 'single' && mode !== 'research' && mode !== 'compare' && mode !== 'sweep') {
    throw new Error(`未知 mode：${mode}（可选：single | research | compare | sweep | event-driven）`);
  }

  // research / compare 共用：先一次性加载 candles，后续切窗回放
  const candles = await loadHistoricalCandles({
    symbol: config.symbol,
    interval: config.interval,
    from: config.from,
    to: config.to,
    file: config.file,
    cacheDir: config.cacheDir,
    dataSource,
  });
  const trainBars = Number(args.train ?? 240);
  const testBars = Number(args.test ?? 120);
  const stepBars = args.step ? Number(args.step) : undefined;
  const cpcvK = Number(args['cpcv-k'] ?? 5);
  const cpcvSize = Number(args['cpcv-size'] ?? 1);

  // —— compare 模式：同一区间、同一策略、params 中某一 boolean 开关 true/false 各跑一次 ——
  if (mode === 'compare') {
    const key = args.compare;
    if (!key) throw new Error('--compare 需提供一个参数名（例：--compare useVolSizing）');
    const base = (config.params ?? {}) as Record<string, unknown>;
    const cfgOn: BacktestConfig = { ...config, params: { ...base, [key]: true } };
    const cfgOff: BacktestConfig = { ...config, params: { ...base, [key]: false } };
    const on = await runResearchOnce(strategyName, cfgOn, candles, trainBars, testBars, stepBars, cpcvK, cpcvSize);
    const off = await runResearchOnce(strategyName, cfgOff, candles, trainBars, testBars, stepBars, cpcvK, cpcvSize);

    const ddDeltaPct = off.wf.oosMaxDrawdownPct > 0
      ? ((off.wf.oosMaxDrawdownPct - on.wf.oosMaxDrawdownPct) / off.wf.oosMaxDrawdownPct) * 100
      : Number.NaN;
    const sharpeDelta = on.wf.aggregateOosSharpe - off.wf.aggregateOosSharpe;

    const outFile =
      args.out ??
      join(
        'reports/backtest',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}-compare-${key}.json`,
      );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          compare: { key, on: briefPayload(on), off: briefPayload(off), delta: { ddReducePct: ddDeltaPct, oosSharpeGain: sharpeDelta } },
          on: fullPayload(on),
          off: fullPayload(off),
        },
        null,
        2,
      ),
    );

    // eslint-disable-next-line no-console
    console.log(
      [
        `回测台·双模式对照 ${strategyName} @ ${config.symbol} ${config.interval}（${candles.length} 根） param=${key}`,
        briefLine('TRUE', on),
        briefLine('FALSE', off),
        `→ 回撤变化 ${Number.isFinite(ddDeltaPct) ? ddDeltaPct.toFixed(2) : 'NaN'}%（正=降低）| OOS Sharpe 变化 ${sharpeDelta.toFixed(2)}`,
        `验收参考 plan §F：回撤降幅 ≥ 30%、OOS Sharpe 抬升 ≥ 3、至少一份 dsr.passed=true`,
        `报告 → ${outFile}`,
      ].join('\n'),
    );
    return;
  }

  // —— sweep 模式：网格扫参，拉 IS Sharpe 候选（下轮迭代的入口） ——
  if (mode === 'sweep') {
    const gridRaw = args.grid;
    if (!gridRaw) throw new Error('--mode sweep 需提供 --grid \'{"emaFast":[6,9,12],...}\'');
    const grid = JSON.parse(gridRaw) as Record<string, number[]>;
    const pboS = args['pbo-s'] ? Number(args['pbo-s']) : undefined;
    const withPbo = pboS !== undefined || args['pbo'] === 'true';
    const res = await runSweep(strategyName, config, candles, grid, withPbo ? { pbo: { nSubsets: pboS } } : {});
    const outFile =
      args.out ??
      join(
        'reports/backtest',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}-sweep.json`,
      );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(res, null, 2));

    // Top-10 by per-bar Sharpe（与 runSweep 选 best 一致）：用 metrics.sharpeRatio 年化展示
    const ranked = res.cells
      .map((c, i) => ({ i, c, sr: c.metrics.sharpeRatio }))
      .sort((a, b) => b.sr - a.sr)
      .slice(0, 10);
    const lines = ranked.map((r, k) => {
      const m = r.c.metrics;
      const p = JSON.stringify(r.c.params);
      const dsrStr = r.c.dsr ? `${r.c.dsr.dsr.toFixed(3)}/${r.c.dsr.passed ? 'pass' : 'overfit'}` : 'n/a';
      return `#${k + 1} sharpe=${m.sharpeRatio.toFixed(2)} ret=${m.totalReturnPct.toFixed(2)}% dd=${m.maxDrawdownPct.toFixed(2)}% dsr=${dsrStr} params=${p}`;
    });
    // eslint-disable-next-line no-console
    console.log(
      [
        `回测台·扫参 ${strategyName} @ ${config.symbol} ${config.interval}（${candles.length} 根） 组合=${res.combos}`,
        `网格键：${res.gridKeys.join(', ')}`,
        `最优 index=${res.bestIndex}`,
        ...lines,
        res.plateau
          ? `冠军 plateau: passed=${res.plateau.passed} worstNeighborDrop=${res.plateau.worstNeighborDropPct.toFixed(2)}% neighbors=${res.plateau.neighborCount}`
          : `冠军 plateau: n/a`,
        res.pbo
          ? `全组合 CSCV-PBO=${res.pbo.pbo.toFixed(4)} (S=${res.pbo.nSubsets}, N=${res.pbo.nConfigs}, combos=${res.pbo.nCombos})`
          : withPbo
            ? `PBO: 未产出（组合<2 或 决策区长度<16）`
            : `PBO: 未开启（加 --pbo true 或 --pbo-s 16 计算）`,
        `报告 → ${outFile}`,
      ].join('\n'),
    );
    return;
  }

  // —— event-driven research（轻量 WF + 统计严格性） ——
  if (args.engine === 'event-driven' || args.engine === 'event') {
    const { withDataSource: wds } = await import('./pull/history-pull');
    const { runBacktestEventDriven } = await import('./event-driven/runner');
    const { approximateWalkForward } = await import('./event-driven/research-bridge');
    const edResult = await wds((ds) =>
      runBacktestEventDriven({
        ds,
        strategy: createStrategy(strategyName),
        config,
        candles,
        allowBarFallback: args['allow-bar-fallback'] === 'true',
      }),
    );
    const eqCurve = edResult.report.equityCurve;
    const wfEd = approximateWalkForward(eqCurve, config, {
      trainBars,
      testBars,
      stepBars,
      warmupBars: config.warmupBars,
    });
    // DSR / MC / regime 从近似 WF OOS 段计算
    const barsPerYearEd = (365 * 86_400_000) / TIMEFRAME_MS[config.interval];
    const obsReturnsEd = perBarReturns(wfEd.oosEquity.map((p) => p.equity));
    const trialSharpesEd = wfEd.segments.map((s) => s.oosSharpe / Math.sqrt(barsPerYearEd));
    const dsrEd = deflatedSharpe({
      obsSharpe: sharpePerBar(obsReturnsEd),
      trialSharpes: trialSharpesEd,
      obsReturns: obsReturnsEd,
    });
    const mcEd = obsReturnsEd.length >= 4 ? blockBootstrapMaxDD(obsReturnsEd, {}) : undefined;
    let regimeEd: RegimeSummaryT | undefined;
    try {
      const byDay = classifyDailyRegimes(aggregateDailyCloses(candles), {});
      if (byDay.size > 0) {
        const s2 = regimeSummary(timedReturnsFromEquity(wfEd.oosEquity), byDay, config.interval);
        if (s2.classifiedBars > 0) regimeEd = s2;
      }
    } catch { regimeEd = undefined; }

    const outFileEd =
      args.out ??
      join(
        'reports/backtest',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}-event-research.json`,
      );
    mkdirSync(dirname(outFileEd), { recursive: true });
    writeFileSync(
      outFileEd,
      JSON.stringify(
        { engineVersion: 'event-driven-v1', wholeSampleReport: edResult.report, walkForwardApprox: wfEd, deflatedSharpe: dsrEd, monteCarlo: mcEd, regime: regimeEd, engineStats: edResult.engineStats },
        null, 2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(
      [
        `event-driven-v1 research ${strategyName} @ ${config.symbol} ${config.interval}（${candles.length} bars，${edResult.engineStats.aggTradeCount} aggTrades）`,
        `WF approx: ${wfEd.segments.length} 窗  IS均 ${wfEd.aggregateIsSharpe} → OOS ${wfEd.aggregateOosSharpe}`,
        `OOS 收益 ${wfEd.oosTotalReturnPct}% | 回撤 ${wfEd.oosMaxDrawdownPct}%`,
        `DSR=${dsrEd.dsr.toFixed(4)} passed=${dsrEd.passed}`,
        mcEd ? `MC maxDD p5/p50/p95 = ${mcEd.maxDD_p5.toFixed(2)}%/${mcEd.maxDD_p50.toFixed(2)}%/${mcEd.maxDD_p95.toFixed(2)}%` : 'MC skip',
        regimeEd ? `Regime ${regimeEd.regimesCovered}桶 min=${regimeEd.minRegimeSharpe.toFixed(2)}` : 'Regime skip',
        `整段回测：费后 ${edResult.report.metrics.totalReturnPct}% | 回撤 ${edResult.report.metrics.maxDrawdownPct}% | 笔数 ${edResult.report.metrics.tradeCount}`,
        `报告 → ${outFileEd}`,
      ].join('\n'),
    );
    return;
  }

  // —— 单份 research ——
  const bundle = await runResearchOnce(strategyName, config, candles, trainBars, testBars, stepBars, cpcvK, cpcvSize);
  const { whole, wf, cv, la, dsr, mc, regime } = bundle;

  const outFile =
    args.out ??
    join(
      'reports/backtest',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${strategyName}-${interval}-research.json`,
    );
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      { wholeSampleReport: whole.report, walkForward: wf, cpcv: cv, deflatedSharpe: dsr, lookahead: la, monteCarlo: mc, regime },
      null,
      2,
    ),
  );

  const gap = wf.aggregateIsSharpe - wf.aggregateOosSharpe;
  // eslint-disable-next-line no-console
  console.log(
    [
      `回测台·稳健性 ${strategyName} @ ${config.symbol} ${config.interval}（${candles.length} 根，预热 ${config.warmupBars}）`,
      `全样本·费后 ${whole.report.metrics.totalReturnPct}% | 夏普（篮子口径）${whole.report.metrics.sharpeRatio}`,
      `walk-forward 窗口：train=${trainBars} test=${testBars} → ${wf.segments.length} 窗`,
      `IS 均 sharpe ${wf.aggregateIsSharpe} → OOS 拼接 sharpe ${wf.aggregateOosSharpe}（落差 ${gap.toFixed(2)}）`,
      `OOS 费后收益 ${wf.oosTotalReturnPct}% | 回撤 ${wf.oosMaxDrawdownPct}% | 笔数 ${wf.oosTradeCount}`,
      `CPCV 组合数 ${cv.nCombos} | mean ${cv.mean.toFixed(2)} | std ${cv.std.toFixed(2)} | 最差 ${cv.min.toFixed(2)} | p5 ${(cv.quantiles[0] ?? 0).toFixed(2)}`,
      `Deflated Sharpe dsr=${dsr.dsr} passed=${dsr.passed}（N=${dsr.nTrials}, T=${dsr.T}, expMax.perBar=${dsr.expectedMaxSharpe.toFixed(4)}）`,
      mc
        ? `Monte Carlo maxDD p5/p50/p95 = ${mc.maxDD_p5.toFixed(2)}% / ${mc.maxDD_p50.toFixed(2)}% / ${mc.maxDD_p95.toFixed(2)}%（block=${mc.block}, n=${mc.n}）`
        : `Monte Carlo 跳过（OOS 收益不足）`,
      regime
        ? `Regime 分层（${regime.regimesCovered} 桶，最差 Sharpe ${regime.minRegimeSharpe.toFixed(2)}）：${regime.buckets
            .map((b) => `${b.regime}=${b.oosSharpe.toFixed(2)}/${b.bars}根`)
            .join(' ')}`
        : `Regime 分层跳过（日线历史不足）`,
      `lookahead 自检 ok=${la.ok}${la.messages.length ? ` messages=${JSON.stringify(la.messages)}` : ''}`,
      `报告 → ${outFile}`,
    ].join('\n'),
  );
}

/** --compare 报告内的缩写块（与 briefLine 保持同字方便前端直接读） */
function briefPayload(b: ResearchBundle) {
  return {
    aggregateIsSharpe: b.wf.aggregateIsSharpe,
    aggregateOosSharpe: b.wf.aggregateOosSharpe,
    oosTotalReturnPct: b.wf.oosTotalReturnPct,
    oosMaxDrawdownPct: b.wf.oosMaxDrawdownPct,
    oosTradeCount: b.wf.oosTradeCount,
    dsr: b.dsr.dsr,
    dsrPassed: b.dsr.passed,
  };
}

/** --compare 报告内的完整块（便于回测台下钻） */
function fullPayload(b: ResearchBundle) {
  return {
    wholeSampleReport: b.whole.report,
    walkForward: b.wf,
    cpcv: b.cv,
    deflatedSharpe: b.dsr,
    lookahead: b.la,
    monteCarlo: b.mc,
    regime: b.regime,
  };
}

main()
  .then(async () => {
    // --source db 会开连接池；跑完显式关闭以免进程挂住
    const { AppDataSource } = await import('../database/data-source');
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('回测失败：', (err as Error).message);
    process.exit(1);
  });
