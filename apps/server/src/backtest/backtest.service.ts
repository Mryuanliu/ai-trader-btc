import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  FUTURES_TAKER_FEE_RATE,
  TIMEFRAMES,
  TIMEFRAME_MS,
  type BacktestConfig,
  type BacktestReport,
  type BacktestRunKind,
  type BacktestRunSummary,
  type Candle,
  type GateCriterion,
  type PageResult,
  type PlateauResult,
  type RegimeSummary,
  type ResearchResult,
  type SweepResult,
  type Timeframe,
} from '@ai-trader/shared';
import { BacktestRunEntity } from '../database/entities/backtest-run.entity';
import { StrategyRegistry } from '../strategy/strategy-registry.service';
import { runBacktestOnCandles } from './backtest-runner';
import { loadHistoricalCandles } from './historical-feed';
import { createStrategyFresh } from './strategy-registry';
import { walkForward } from './research/walk-forward';
import { cpcv, type CpcvOptions } from './research/cpcv';
import { runSweep } from './research/sweep';
import { deflatedSharpe } from './research/deflated-sharpe';
import { perBarReturns, sharpePerBar } from './research/stats';
import { computePbo } from './research/pbo';
import {
  aggregateDailyCloses,
  classifyDailyRegimes,
  regimeSummary,
  timedReturnsFromEquity,
} from './research/regime';
import { blockBootstrapMaxDD } from './research/monte-carlo';
import { normalizePagination, toPageResult } from '../common/pagination';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = 'reports/backtest/data';
/** 单次回测最大跨度（天）：兆住 walk-forward/sweep 放大后的耗时 */
const MAX_RANGE_DAYS = 540;

/**
 * 闸门判据常量（v2：统计严格性对齐 A6）。放行须所有已量化判据全 pass；
 * `skip`（本次未产出该度量 / 设计范围外）不阻断，但会在 reasons 之外如实列示。
 * 注：定稿引擎判据（engine_v2）已定性为范围外——vectorized-v1 与实盘 1m 同粒度即为
 * 本阶段定稿引擎，event-driven L2/冲击模型不再作为“待落地后转硬”的悬置项。
 */
const GATE_DSR_MIN = 0.5;
const GATE_OOS_SHARPE_MIN = 0;
const GATE_OOS_MAX_DD_PCT = 10;
const GATE_FRESHNESS_DAYS = 30;
const GATE_CPCV_P5_MIN = 0;
const GATE_PBO_MAX = 0.2;
const GATE_MC_DD_MAX = 10;
const GATE_REGIME_MIN = -0.3;

/** 当前留存结果所属的撮合引擎版本（与实盘 1m 同粒度，即本阶段定稿引擎；见 engine_v2 判据说明） */
const ENGINE_VERSION = 'vectorized-v1';

export interface GateVerdict {
  passed: boolean;
  reasons: string[];
  dsr?: number;
  oosSharpe?: number;
  oosMaxDD?: number;
  runId?: string;
  /** v2 逐条判据明细（前端可展示哪条未达 / 哪条待 P1） */
  criteria: GateCriterion[];
}

export interface RunInput {
  strategyName: string;
  symbol: string;
  interval: Timeframe;
  from?: number;
  to?: number;
  initialCapital?: number;
  warmupBars?: number;
  feeRateBps?: number;
  slippageBps?: number;
  fundingPctPer8h?: number;
  params?: Record<string, unknown>;
  file?: string;
  label?: string;
  dsrThreshold?: number;
  /** PBO 用额外配置集（冠军邻域）；缺省则跳过 PBO 判据 */
  pbo?: { grid?: Record<string, number[]>; configs?: Record<string, unknown>[]; nSubsets?: number };
}

/** 把入参归一成 BacktestConfig，套用与 CLI 一致的默认值 */
function resolveConfig(input: RunInput): BacktestConfig {
  if (!input.strategyName) throw new Error('缺少 strategyName');
  if (!(TIMEFRAMES as readonly string[]).includes(input.interval)) {
    throw new Error(`非法周期：${input.interval}`);
  }
  const symbol = (input.symbol || 'BTCUSDT').toUpperCase();
  const from = input.from;
  const to = input.to ?? Date.now();
  if (!input.file) {
    if (!from) throw new Error('需要 from（或用 file 指定本地数据）');
    if ((to - from) / DAY_MS > MAX_RANGE_DAYS) {
      throw new Error(`区间过大（>${MAX_RANGE_DAYS} 天），请缩小范围`);
    }
  }
  return {
    symbol,
    interval: input.interval,
    from,
    to,
    initialCapital: input.initialCapital ?? 10_000,
    warmupBars: input.warmupBars ?? 120,
    feeRateBps: input.feeRateBps ?? Math.round(FUTURES_TAKER_FEE_RATE * 10_000),
    slippageBps: input.slippageBps ?? 5,
    fundingPctPer8h: input.fundingPctPer8h ?? 0,
    strategyName: input.strategyName,
    params: input.params,
    file: input.file,
    cacheDir: DEFAULT_CACHE_DIR,
  };
}

function toSummary(e: BacktestRunEntity): BacktestRunSummary {
  return {
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    label: e.label,
    kind: e.kind,
    strategyName: e.strategyName,
    symbol: e.symbol,
    interval: e.interval,
    from: e.from,
    to: e.to,
    initialCapital: e.initialCapital,
    totalReturnPct: e.totalReturnPct,
    sharpe: e.sharpe,
    oosSharpe: e.oosSharpe,
    dsr: e.dsr,
    pbo: e.pbo,
    engineVersion: e.engineVersion ?? undefined,
  };
}

/**
 * 回测服务：装配策略 + 回放 + 防过拟合闸门，并把每次运行落库留历史。
 *
 * K 线只加载一次（复用 runBacktestOnCandles 的切窗能力），walk-forward/CPCV/sweep 不再重复拉盘。
 */
@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly repo: Repository<BacktestRunEntity>,
    @Inject(forwardRef(() => StrategyRegistry))
    private readonly strategyRegistry: StrategyRegistry,
  ) {}

  /** 服务侧白名单：Nest StrategyRegistry 未登记的策略一律拒绝（CLI 无此限制） */
  private assertListed(strategyName: string): void {
    if (!this.strategyRegistry.get(strategyName)) {
      throw new Error(`策略未上架：${strategyName}`);
    }
  }

  private async loadCandles(config: BacktestConfig): Promise<Candle[]> {
    return loadHistoricalCandles({
      symbol: config.symbol,
      interval: config.interval,
      from: config.from,
      to: config.to,
      file: config.file,
      cacheDir: config.cacheDir,
      // DB market_candles 作优先离线源（多年 1m 归档灌库后免联网）；未命中自动回退联网
      dataSource: this.repo.manager.connection,
    });
  }

  /** 单次回测：返回完整报告并落库 */
  async run(input: RunInput): Promise<BacktestReport> {
    const config = resolveConfig(input);
    this.assertListed(config.strategyName);
    const candles = await this.loadCandles(config);
    const result = await runBacktestOnCandles(
      createStrategyFresh(config.strategyName, this.strategyRegistry),
      config,
      candles,
    );
    const report = result.report;
    await this.persist('single', config, input.label, report, {
      totalReturnPct: report.metrics.totalReturnPct,
      sharpe: report.metrics.sharpeRatio,
      oosSharpe: null,
      dsr: null,
      engineVersion: ENGINE_VERSION,
    });
    return report;
  }

  /** 稳健性研究：walk-forward（+ 可选 CPCV）+ Deflated Sharpe 上架闸门 */
  async research(
    input: RunInput,
    scheme: { trainBars: number; testBars: number; stepBars?: number; cpcv?: CpcvOptions },
  ): Promise<ResearchResult> {
    const config = resolveConfig(input);
    this.assertListed(config.strategyName);
    const candles = await this.loadCandles(config);
    const wf = await walkForward(config.strategyName, config, candles, {
      trainBars: scheme.trainBars,
      testBars: scheme.testBars,
      stepBars: scheme.stepBars,
    });
    const cpcvRes = await cpcv(config.strategyName, config, candles, scheme.cpcv ?? {});

    // DSR：观测 = 拼接 OOS 逐根收益；试验集合 = 各窗 OOS 夏普（年化→per-bar）
    const barsPerYear = (365 * DAY_MS) / TIMEFRAME_MS[config.interval];
    const obsReturns = perBarReturns(wf.oosEquity.map((p) => p.equity));
    const trialSharpes = wf.segments.map((s) => s.oosSharpe / Math.sqrt(barsPerYear));
    const dsr = deflatedSharpe({
      obsSharpe: sharpePerBar(obsReturns),
      trialSharpes,
      obsReturns,
      threshold: input.dsrThreshold,
    });

    // ---- A6 v2 新增统计验证（均在已切好的 OOS 拼接曲线上做二次度量）----
    // Monte Carlo：block bootstrap 回撤分布（坏运气路径下的回撤仍须可承受）
    const mc = obsReturns.length >= 4 ? blockBootstrapMaxDD(obsReturns, {}) : undefined;

    // Regime 分层：确认 edge 是否只在某一市况兑现（趋势市独家=震荡打脸的隐患）
    let regime: ResearchResult['regime'];
    try {
      const daily = aggregateDailyCloses(candles);
      const byDay = classifyDailyRegimes(daily, {});
      if (byDay.size > 0) {
        const summary = regimeSummary(timedReturnsFromEquity(wf.oosEquity), byDay, config.interval);
        if (summary.classifiedBars > 0) regime = summary;
      }
    } catch {
      regime = undefined;
    }

    // PBO：需一组「可比较的候选配置」（冠军邻域），未提供则跳过（不阻断，但闸门标 skip）
    let pboRes: ResearchResult['pbo'];
    const pboConfigs = this.resolvePboConfigs(input);
    if (pboConfigs && pboConfigs.length >= 2) {
      try {
        pboRes = await computePbo(config.strategyName, config, candles, pboConfigs, {
          nSubsets: input.pbo?.nSubsets,
        });
      } catch (err) {
        this.logger.warn(`PBO 计算跳过：${(err as Error).message}`);
      }
    }

    const verdict = dsr.passed ? 'pass' : 'overfit';
    const note = dsr.passed
      ? `walk-forward OOS 夏普 ${wf.aggregateOosSharpe}（IS ${wf.aggregateIsSharpe}），DSR ${dsr.dsr.toFixed(3)} ≥ 阈值，未见显著过拟合`
      : `OOS 夏普 ${wf.aggregateOosSharpe} 显著低于 IS ${wf.aggregateIsSharpe}，DSR ${dsr.dsr.toFixed(3)} 未过阈值 → 判过拟合，不建议上架`;

    const result: ResearchResult = {
      walkForward: wf,
      cpcv: cpcvRes,
      deflatedSharpe: dsr,
      pbo: pboRes,
      regime,
      monteCarlo: mc,
      verdict,
      note,
    };
    await this.persist('research', config, input.label, result, {
      totalReturnPct: wf.oosTotalReturnPct,
      sharpe: wf.aggregateIsSharpe,
      oosSharpe: wf.aggregateOosSharpe,
      dsr: dsr.dsr,
      pbo: pboRes?.pbo ?? null,
      mcMaxDDp95: mc?.maxDD_p95 ?? null,
      regimeSummary: regime ?? null,
      cpcvQuantiles: cpcvRes?.quantiles ?? null,
      engineVersion: ENGINE_VERSION,
    });
    return result;
  }

  /** 参数扫描：网格每组独立回放 + 逐组合 DSR */
  async sweep(input: RunInput, grid: Record<string, number[]>): Promise<SweepResult> {
    const config = resolveConfig(input);
    this.assertListed(config.strategyName);
    const candles = await this.loadCandles(config);
    const res = await runSweep(config.strategyName, config, candles, grid);
    const best = res.cells[res.bestIndex];
    await this.persist('sweep', config, input.label, res, {
      totalReturnPct: best?.metrics.totalReturnPct ?? null,
      sharpe: best?.metrics.sharpeRatio ?? null,
      oosSharpe: null,
      dsr: best?.dsr?.dsr ?? null,
      plateauScore: res.plateau?.worstNeighborDropPct ?? null,
      engineVersion: ENGINE_VERSION,
    });
    return res;
  }

  /** 历史列表（分页，摘要列） */
  async listRuns(
    params: { page?: number; pageSize?: number; strategyName?: string; kind?: BacktestRunKind },
  ): Promise<PageResult<BacktestRunSummary>> {
    const { page, pageSize, skip, take } = normalizePagination(params);
    const where: Record<string, unknown> = {};
    if (params.strategyName) where.strategyName = params.strategyName;
    if (params.kind) where.kind = params.kind;
    const [rows, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take,
    });
    return toPageResult(rows.map(toSummary), total, page, pageSize);
  }

  /** 取回单次运行的完整结果 */
  async getRun(id: string): Promise<BacktestRunSummary & { report: unknown }> {
    const e = await this.repo.findOne({ where: { id: In([id]) } });
    if (!e) throw new Error(`回测运行不存在：${id}`);
    return { ...toSummary(e), report: e.report };
  }

  async deleteRun(id: string): Promise<{ ok: boolean }> {
    await this.repo.delete({ id });
    return { ok: true };
  }

  /**
   * 闸门判定 v2（A6）：逐条量化判据，全 pass 才放行。
   *
   * 硬判据（未达 → fail → 阻断）：
   *  1. sweep DSR ≥ 0.5
   *  2. research OOS Sharpe > 0
   *  3. research WF OOS 回撤 < 10%
   *  4. CPCV p5 OOS Sharpe > 0（接进闸门：此前算了不读）
   *  5. Monte Carlo maxDD p95 < 10%
   *  6. 五 regime OOS Sharpe 全 > -0.3
   *  7. 参数高原（冠军邻域掉幅 ≤ 20%）
   *  8. PBO < 20%（需额外网格；未给 → skip）
   * 范围外（不作为放行判据）：
   *  9. 定稿引擎：vectorized-v1 与实盘 1m 同粒度即定稿引擎；event-driven L2/冲击模型为设计范围外
   *
   * `skip` 不阻断，但如实列在 criteria。
   */
  async hasPassingResearch(strategyName: string): Promise<GateVerdict> {
    const since = new Date(Date.now() - GATE_FRESHNESS_DAYS * DAY_MS);

    const c = (
      key: string,
      label: string,
      requirement: string,
      status: GateCriterion['status'],
      extra?: Partial<GateCriterion>,
    ): GateCriterion => ({ key, label, requirement, status, ...extra });
    const byKey: Record<string, GateCriterion> = {
      freshness: c('freshness', '新鲜度', '30 天内有 sweep + research', 'pass'),
      dsr: c('dsr', 'DSR', `≥ ${GATE_DSR_MIN}`, 'pass'),
      oos_sharpe: c('oos_sharpe', 'OOS Sharpe', `> ${GATE_OOS_SHARPE_MIN}`, 'pass'),
      oos_maxdd: c('oos_maxdd', 'WF OOS 回撤', `< ${GATE_OOS_MAX_DD_PCT}%`, 'pass'),
      cpcv_p5: c('cpcv_p5', 'CPCV p5 OOS Sharpe', `> ${GATE_CPCV_P5_MIN}`, 'pass'),
      mc_dd95: c('mc_dd95', 'MC maxDD p95', `< ${GATE_MC_DD_MAX}%`, 'pass'),
      regime: c('regime', 'Regime 分层', `五桶 OOS Sharpe 全 > ${GATE_REGIME_MIN}`, 'pass'),
      plateau: c('plateau', '参数高原', '冠军邻域掉幅 ≤ 20%', 'pass'),
      pbo: c('pbo', 'PBO', `< ${GATE_PBO_MAX}`, 'pass'),
      engine_v2: c(
        'engine_v2',
        '定稿引擎',
        'vectorized-v1（与实盘 1m 同粒度）即本阶段定稿引擎',
        'skip',
        { detail: `留存结果来自 ${ENGINE_VERSION}；event-driven L2/冲击模型为设计范围外，不作为放行判据` },
      ),
    };

    let dsrVal: number | undefined;
    let oosSharpeVal: number | undefined;
    let oosMaxDD: number | undefined;

    // ---- sweep：新鲜度 / DSR / 高原 ----
    const sweepRun = await this.repo.findOne({
      where: { strategyName, kind: 'sweep' as const },
      order: { createdAt: 'DESC' },
    });
    const sweepFresh = sweepRun && sweepRun.createdAt >= since ? sweepRun : null;
    if (!sweepFresh) {
      byKey.freshness.status = 'fail';
      byKey.freshness.detail = '无 30 天内 sweep 运行';
      byKey.dsr.status = 'fail';
      byKey.dsr.detail = '无 30 天内 sweep 运行';
      byKey.plateau.status = 'skip';
      byKey.plateau.detail = '无 sweep';
    } else {
      dsrVal = sweepFresh.dsr ?? undefined;
      if (dsrVal == null || dsrVal < GATE_DSR_MIN) {
        byKey.dsr.status = 'fail';
        byKey.dsr.value = dsrVal;
        byKey.dsr.detail = `sweep DSR=${dsrVal?.toFixed(3) ?? 'null'} < ${GATE_DSR_MIN}`;
      } else {
        byKey.dsr.value = dsrVal;
      }
      const swRpt = sweepFresh.report as Record<string, unknown> | null;
      const plat = (swRpt?.plateau as PlateauResult | undefined) ?? undefined;
      if (plat && plat.neighborCount > 0) {
        byKey.plateau.status = plat.passed ? 'pass' : 'fail';
        byKey.plateau.value = plat.worstNeighborDropPct;
        byKey.plateau.detail = `冠军邻域最大掉幅 ${plat.worstNeighborDropPct.toFixed(1)}%（${plat.neighborCount} 邻居）`;
      } else {
        byKey.plateau.status = 'skip';
        byKey.plateau.detail = '网格无可比邻域（旧报告或单点网格）';
      }
    }

    // ---- research：新鲜度 / OOS Sharpe / 回撤 / CPCV / MC / regime / PBO ----
    const researchRun = await this.repo.findOne({
      where: { strategyName, kind: 'research' as const },
      order: { createdAt: 'DESC' },
    });
    const researchFresh = researchRun && researchRun.createdAt >= since ? researchRun : null;
    if (!researchFresh) {
      byKey.freshness.status = 'fail';
      byKey.freshness.detail = [byKey.freshness.detail, '无 30 天内 research 运行']
        .filter(Boolean)
        .join('；');
      for (const k of ['oos_sharpe', 'oos_maxdd', 'cpcv_p5', 'mc_dd95', 'regime', 'pbo']) {
        byKey[k].status = 'fail';
        byKey[k].detail = '无 30 天内 research 运行';
      }
    } else {
      const rpt = researchFresh.report as Record<string, unknown> | null;
      const wfData = (rpt?.walkForward ?? rpt) as Record<string, unknown> | undefined;
      const cpcv = rpt?.cpcv as Record<string, unknown> | undefined;
      const mc = rpt?.monteCarlo as Record<string, unknown> | undefined;
      const regime = rpt?.regime as Record<string, unknown> | undefined;
      const pbo = rpt?.pbo as Record<string, unknown> | undefined;

      oosSharpeVal = researchFresh.oosSharpe ?? undefined;
      if (oosSharpeVal == null || oosSharpeVal <= GATE_OOS_SHARPE_MIN) {
        byKey.oos_sharpe.status = 'fail';
        byKey.oos_sharpe.value = oosSharpeVal;
        byKey.oos_sharpe.detail = `OOS Sharpe=${oosSharpeVal?.toFixed(3) ?? 'null'}`;
      } else {
        byKey.oos_sharpe.value = oosSharpeVal;
      }

      oosMaxDD = (wfData?.oosMaxDrawdownPct as number) ?? undefined;
      if (oosMaxDD == null) {
        byKey.oos_maxdd.status = 'skip';
        byKey.oos_maxdd.detail = '报告缺 oosMaxDrawdownPct';
      } else if (oosMaxDD >= GATE_OOS_MAX_DD_PCT) {
        byKey.oos_maxdd.status = 'fail';
        byKey.oos_maxdd.value = oosMaxDD;
        byKey.oos_maxdd.detail = `OOS 回撤=${oosMaxDD.toFixed(2)}%`;  
      } else {
        byKey.oos_maxdd.value = oosMaxDD;
      }

      const cpcvP5 = Array.isArray(cpcv?.quantiles) ? (cpcv?.quantiles as number[])[0] : undefined;
      if (cpcvP5 == null) {
        byKey.cpcv_p5.status = 'skip';
        byKey.cpcv_p5.detail = '旧报告无 CPCV（重跑 research 即可产出）';
      } else if (cpcvP5 <= GATE_CPCV_P5_MIN) {
        byKey.cpcv_p5.status = 'fail';
        byKey.cpcv_p5.value = cpcvP5;
        byKey.cpcv_p5.detail = `CPCV p5 OOS Sharpe=${cpcvP5.toFixed(3)}`;
      } else {
        byKey.cpcv_p5.value = cpcvP5;
      }

      const mcP95 = (mc?.maxDD_p95 as number) ?? undefined;
      if (mcP95 == null) {
        byKey.mc_dd95.status = 'skip';
        byKey.mc_dd95.detail = '旧报告无 Monte Carlo（重跑 research 即可产出）';
      } else if (mcP95 >= GATE_MC_DD_MAX) {
        byKey.mc_dd95.status = 'fail';
        byKey.mc_dd95.value = mcP95;
        byKey.mc_dd95.detail = `MC maxDD p95=${mcP95.toFixed(2)}%`;
      } else {
        byKey.mc_dd95.value = mcP95;
      }

      const minRegime = (regime?.minRegimeSharpe as number) ?? undefined;
      const classified = (regime?.classifiedBars as number) ?? 0;
      if (regime == null || !Number.isFinite(minRegime) || classified === 0) {
        byKey.regime.status = 'skip';
        byKey.regime.detail = '日线 regime 历史不足或旧报告未含分层';
      } else if ((minRegime as number) <= GATE_REGIME_MIN) {
        byKey.regime.status = 'fail';
        byKey.regime.value = minRegime;
        byKey.regime.detail = `最差 regime OOS Sharpe=${(minRegime as number).toFixed(3)}`;
      } else {
        byKey.regime.value = minRegime;
      }

      const pboVal = (pbo?.pbo as number) ?? undefined;
      if (pboVal == null) {
        byKey.pbo.status = 'skip';
        byKey.pbo.detail = '未提供 PBO 网格（input.pbo.grid/configs）';
      } else if (pboVal >= GATE_PBO_MAX) {
        byKey.pbo.status = 'fail';
        byKey.pbo.value = pboVal;
        byKey.pbo.detail = `PBO=${pboVal.toFixed(3)}`;
      } else {
        byKey.pbo.value = pboVal;
      }
    }

    const criteria = Object.values(byKey);
    const reasons = criteria
      .filter((x) => x.status === 'fail')
      .map((x) => `${x.label} 未达（${x.requirement}）${x.detail ? `：${x.detail}` : ''}`);
    const passed = reasons.length === 0;

    return {
      passed,
      reasons,
      criteria,
      dsr: dsrVal,
      oosSharpe: oosSharpeVal,
      oosMaxDD,
      runId: sweepFresh?.id ?? researchFresh?.id,
    };
  }

  /** 解析 PBO 配置集：显式 configs 优先；否则由小网格笛卡尔积展开（上限防炸） */
  private resolvePboConfigs(input: RunInput): Record<string, unknown>[] | undefined {
    const p = input.pbo;
    if (!p) return undefined;
    if (p.configs && p.configs.length >= 2) return p.configs;
    if (p.grid && Object.keys(p.grid).length > 0) {
      const keys = Object.keys(p.grid);
      let acc: Record<string, number>[] = [{}];
      for (const key of keys) {
        const next: Record<string, number>[] = [];
        for (const combo of acc) {
          for (const v of p.grid[key]) next.push({ ...combo, [key]: v });
        }
        acc = next;
      }
      return acc.slice(0, 24);
    }
    return undefined;
  }

  private async persist(
    kind: BacktestRunKind,
    config: BacktestConfig,
    label: string | undefined,
    report: unknown,
    metrics: {
      totalReturnPct: number | null;
      sharpe: number | null;
      oosSharpe: number | null;
      dsr: number | null;
      pbo?: number | null;
      mcMaxDDp95?: number | null;
      plateauScore?: number | null;
      cpcvQuantiles?: number[] | null;
      regimeSummary?: RegimeSummary | null;
      engineVersion?: string | null;
    },
  ): Promise<void> {
    try {
      const row = this.repo.create({
        kind,
        label: label ?? null,
        strategyName: config.strategyName,
        symbol: config.symbol,
        interval: config.interval,
        from: config.from ?? 0,
        to: config.to ?? 0,
        initialCapital: config.initialCapital,
        report,
        totalReturnPct: metrics.totalReturnPct,
        sharpe: metrics.sharpe,
        oosSharpe: metrics.oosSharpe,
        dsr: metrics.dsr,
        pbo: metrics.pbo ?? null,
        mcMaxDDp95: metrics.mcMaxDDp95 ?? null,
        plateauScore: metrics.plateauScore ?? null,
        cpcvQuantiles: metrics.cpcvQuantiles ?? null,
        regimeSummary: metrics.regimeSummary ?? null,
        engineVersion: metrics.engineVersion ?? ENGINE_VERSION,
      });
      await this.repo.save(row);
    } catch (err) {
      // 落库失败不该让回测本身失败——结果已算出，仅历史留存降级
      this.logger.warn(`回测结果落库失败：${(err as Error).message}`);
    }
  }
}
