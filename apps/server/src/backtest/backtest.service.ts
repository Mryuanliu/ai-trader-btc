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
  type PageResult,
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
import { normalizePagination, toPageResult } from '../common/pagination';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = 'reports/backtest/data';
/** 单次回测最大跨度（天）：兆住 walk-forward/sweep 放大后的耗时 */
const MAX_RANGE_DAYS = 540;

/** 闸门判据常量（Iter4 调整：适配低频趋势跟踪策略） */
const GATE_DSR_MIN = 0.5;
const GATE_OOS_SHARPE_MIN = 0;
const GATE_OOS_MAX_DD_PCT = 10;
const GATE_FRESHNESS_DAYS = 30;

export interface GateVerdict {
  passed: boolean;
  reasons: string[];
  dsr?: number;
  oosSharpe?: number;
  oosMaxDD?: number;
  runId?: string;
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
    const cpcvRes = scheme.cpcv ? await cpcv(config.strategyName, config, candles, scheme.cpcv) : undefined;

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

    const verdict = dsr.passed ? 'pass' : 'overfit';
    const note = dsr.passed
      ? `walk-forward OOS 夏普 ${wf.aggregateOosSharpe}（IS ${wf.aggregateIsSharpe}），DSR ${dsr.dsr.toFixed(3)} ≥ 阈值，未见显著过拟合`
      : `OOS 夏普 ${wf.aggregateOosSharpe} 显著低于 IS ${wf.aggregateIsSharpe}，DSR ${dsr.dsr.toFixed(3)} 未过阈值 → 判过拟合，不建议上架`;

    const result: ResearchResult = {
      walkForward: wf,
      cpcv: cpcvRes,
      deflatedSharpe: dsr,
      verdict,
      note,
    };
    await this.persist('research', config, input.label, result, {
      totalReturnPct: wf.oosTotalReturnPct,
      sharpe: wf.aggregateIsSharpe,
      oosSharpe: wf.aggregateOosSharpe,
      dsr: dsr.dsr,
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
   * 闸门判定：检查策略最近 30 天内是否有通过的 sweep + research。
   *
   * 新判据（适配低频趋势跟踪）：
   * 1. sweep DSR ≥ 0.5
   * 2. research walk-forward aggregateOosSharpe > 0
   * 3. research oosMaxDrawdownPct < 10%
   *
   * 全部满足返回 passed=true，否则 reasons 列出未达项。
   */
  async hasPassingResearch(strategyName: string): Promise<GateVerdict> {
    const since = new Date(Date.now() - GATE_FRESHNESS_DAYS * DAY_MS);
    const reasons: string[] = [];

    // --- sweep ---
    const sweepRun = await this.repo.findOne({
      where: { strategyName, kind: 'sweep' as const, createdAt: undefined },
      order: { createdAt: 'DESC' },
    });
    // 手动过滤时间
    const sweepFresh = sweepRun && sweepRun.createdAt >= since ? sweepRun : null;
    let dsrVal: number | undefined;
    if (!sweepFresh) {
      reasons.push(`无 30 天内 sweep 运行`);
    } else {
      dsrVal = sweepFresh.dsr ?? undefined;
      if (dsrVal == null || dsrVal < GATE_DSR_MIN) {
        reasons.push(`sweep DSR=${dsrVal?.toFixed(3) ?? 'null'} < ${GATE_DSR_MIN}`);
      }
    }

    // --- research ---
    const researchRun = await this.repo.findOne({
      where: { strategyName, kind: 'research' as const, createdAt: undefined },
      order: { createdAt: 'DESC' },
    });
    const researchFresh = researchRun && researchRun.createdAt >= since ? researchRun : null;
    let oosSharpeVal: number | undefined;
    let oosMaxDD: number | undefined;
    if (!researchFresh) {
      reasons.push(`无 30 天内 research 运行`);
    } else {
      oosSharpeVal = researchFresh.oosSharpe ?? undefined;
      if (oosSharpeVal == null || oosSharpeVal <= GATE_OOS_SHARPE_MIN) {
        reasons.push(`OOS Sharpe=${oosSharpeVal?.toFixed(3) ?? 'null'} ≤ ${GATE_OOS_SHARPE_MIN}`);
      }
      // 从 report JSON 提取 oosMaxDrawdownPct
      const rpt = researchFresh.report as Record<string, unknown> | null;
      const wfData = (rpt?.walkForward ?? rpt) as Record<string, unknown> | undefined;
      oosMaxDD = (wfData?.oosMaxDrawdownPct as number) ?? undefined;
      if (oosMaxDD != null && oosMaxDD >= GATE_OOS_MAX_DD_PCT) {
        reasons.push(`OOS 回撤=${oosMaxDD.toFixed(2)}% ≥ ${GATE_OOS_MAX_DD_PCT}%`);
      }
    }

    const passed = reasons.length === 0;
    return {
      passed,
      reasons,
      dsr: dsrVal,
      oosSharpe: oosSharpeVal,
      oosMaxDD,
      runId: sweepFresh?.id ?? researchFresh?.id,
    };
  }

  private async persist(
    kind: BacktestRunKind,
    config: BacktestConfig,
    label: string | undefined,
    report: unknown,
    metrics: { totalReturnPct: number | null; sharpe: number | null; oosSharpe: number | null; dsr: number | null },
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
      });
      await this.repo.save(row);
    } catch (err) {
      // 落库失败不该让回测本身失败——结果已算出，仅历史留存降级
      this.logger.warn(`回测结果落库失败：${(err as Error).message}`);
    }
  }
}
