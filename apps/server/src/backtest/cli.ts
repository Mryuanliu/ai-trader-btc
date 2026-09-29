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
import type { Candle } from '@ai-trader/shared';

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
  return { whole, wf, cv, la, dsr };
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

  if (mode === 'single') {
    const result = await runBacktest(createStrategy(strategyName), config);
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
    throw new Error(`未知 mode：${mode}（可选：single | research | compare | sweep）`);
  }

  // research / compare 共用：先一次性加载 candles，后续切窗回放
  const candles = await loadHistoricalCandles({
    symbol: config.symbol,
    interval: config.interval,
    from: config.from,
    to: config.to,
    file: config.file,
    cacheDir: config.cacheDir,
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
    const res = await runSweep(strategyName, config, candles, grid);
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
        `报告 → ${outFile}`,
      ].join('\n'),
    );
    return;
  }

  // —— 单份 research ——
  const bundle = await runResearchOnce(strategyName, config, candles, trainBars, testBars, stepBars, cpcvK, cpcvSize);
  const { whole, wf, cv, la, dsr } = bundle;

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
      { wholeSampleReport: whole.report, walkForward: wf, cpcv: cv, deflatedSharpe: dsr, lookahead: la },
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
      `CPCV 组合数 ${cv.nCombos} | mean ${cv.mean.toFixed(2)} | std ${cv.std.toFixed(2)} | 最差 ${cv.min.toFixed(2)}`,
      `Deflated Sharpe dsr=${dsr.dsr} passed=${dsr.passed}（N=${dsr.nTrials}, T=${dsr.T}, expMax.perBar=${dsr.expectedMaxSharpe.toFixed(4)}）`,
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
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('回测失败：', (err as Error).message);
  process.exit(1);
});
