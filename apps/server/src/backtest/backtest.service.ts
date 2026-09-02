import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  strategyRegistry,
  type Timeframe,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { FundingRateEntity, MarketCandleEntity } from '../database/entities';
import { BusinessException } from '../common/business.exception';
import { backfill, loadRange, backfillFunding, loadFundingRange } from './candle-source';
import { runFuturesBacktest } from './futures-engine';
import type {
  FuturesBacktestConfig,
  FuturesBacktestReport,
  FuturesLeverageComparison,
  FuturesLeverageRow,
} from './types';

/** 区间应有根数上限：HTTP 同步回测防止拉取/计算过量（官方数据包入库后 1m 短中期均可） */
const MAX_EXPECTED_BARS = 150_000;
/** 报告 equityCurve 下采样上限，控制响应体积 */
const MAX_CURVE_POINTS = 2_000;
/** HTTP 报告 trades 保留上限（只保留最近 N 笔） */
const MAX_TRADES = 2_000;

/** 回测请求体（与 CLI 参数同口径，日期用 ISO 字符串便于 JSON 传输） */
export interface BacktestRequestDto {
  symbol?: string;
  interval?: Timeframe;
  from: string;
  to: string;
  initialCapital?: number;
  slippageBps?: number;
  feeRateBps?: number;
  positionPct?: number;
  minConfidence?: number;
  strategyName?: string;
  strategyParams?: Record<string, unknown>;
  exitRules?: { stopLossPct?: number | null; takeProfitPct?: number | null };
  warmupBars?: number;
  /** 数据稀疏/缺失时是否自动从 Binance 公共 REST 回填（默认 true） */
  autoBackfill?: boolean;
  /** 兼容字段：仅接受 futures（本项目只做合约回测，现货回测已移除） */
  market?: 'futures';
  /** 合约杠杆 1~10（默认 5） */
  leverage?: number;
  /** 数量步进；不传按 symbol 兜底 BTCUSDT=0.0001 */
  stepSize?: number;
  /** 最小名义价值；不传按合约口径 50 兜底 */
  minNotional?: number;
  /** 合约回测附加输出 1x/3x/5x 杠杆对比表（默认 false） */
  compareLeverage?: boolean;
}

/** 回测执行进度（供前端轮询展示） */
export interface BacktestProgress {
  stage: 'loading' | 'backfill' | 'compute';
  /** 0~100 */
  pct: number;
  detail: string;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  /** 防止并发回测打爆 DB / 交易所 */
  private running = false;
  /** 当前回测进度；空闲为 null */
  private progress: BacktestProgress | null = null;

  getProgress(): BacktestProgress | null {
    return this.progress;
  }

  private setProgress(stage: BacktestProgress['stage'], pct: number, detail: string): void {
    this.progress = { stage, pct: Math.round(pct), detail };
  }

  constructor(
    @InjectRepository(MarketCandleEntity)
    private readonly candleRepo: Repository<MarketCandleEntity>,
    @InjectRepository(FundingRateEntity)
    private readonly fundingRepo: Repository<FundingRateEntity>,
  ) {}

  async run(
    dto: BacktestRequestDto,
  ): Promise<FuturesBacktestReport | FuturesLeverageComparison> {
    if (this.running) {
      throw new BusinessException('BAD_REQUEST','已有回测在运行中，请稍后再试');
    }
    this.running = true;
    this.progress = { stage: 'loading', pct: 0, detail: '加载 K 线…' };
    try {
      const report = await this.doRun(dto);
      this.progress = { stage: 'compute', pct: 100, detail: '完成' };
      return report;
    } finally {
      this.running = false;
      // 延迟清空：给前端最后一次轮询留 ~2s 读到 100%，之后空闲
      setTimeout(() => (this.progress = null), 2000);
    }
  }

  private async doRun(
    dto: BacktestRequestDto,
  ): Promise<FuturesBacktestReport | FuturesLeverageComparison> {
    // 仅合约：现货回测（runBacktest/engine.ts）已随现货链路移除
    return this.doRunFutures(dto);
  }

  /**
   * 合约回测。
   *
   * 与现货的差异：数据走 fapi（含基差）、附加资金费回填与计费、
   * 杠杆/步进/最小名义为必配参数；compareLeverage=true 时附加
   * 1x/3x/5x 三份独立回测的指标对比表（同一策略同一数据，只有杠杆不同）。
   */
  private async doRunFutures(
    dto: BacktestRequestDto,
  ): Promise<FuturesBacktestReport | FuturesLeverageComparison> {
    const { symbol, interval, from, to, stepMs, expectedBars } = this.normalizeRange(dto);

    const { strategy, fellBack } = strategyRegistry.getOrDefault(dto.strategyName ?? 'trend_following');
    if (fellBack) throw new BusinessException('BAD_REQUEST', `策略 ${dto.strategyName} 不存在`);

    const cfg: FuturesBacktestConfig = {
      symbol,
      interval,
      from,
      to,
      initialCapital: dto.initialCapital ?? 10_000,
      slippageBps: dto.slippageBps ?? 5,
      feeRateBps: dto.feeRateBps ?? 10,
      positionPct: clamp(dto.positionPct ?? 0.1, 0.001, 1),
      minConfidence: clamp(dto.minConfidence ?? 0.6, 0, 1),
      strategyName: strategy.name,
      strategyParams: dto.strategyParams,
      exitRules: dto.exitRules,
      warmupBars: dto.warmupBars ?? 120,
      // 杠杆钳制 1~10：与实盘 RISK_LIMITS 同口径
      leverage: clamp(Math.round(dto.leverage ?? 5), 1, 10),
      stepSize: dto.stepSize && dto.stepSize > 0 ? dto.stepSize : 0.0001,
      // 实测各标的最小名义不同（BTCUSDT=50），50 为保守兜底
      minNotional: dto.minNotional && dto.minNotional > 0 ? dto.minNotional : 50,
    };

    let candles = await loadRange(this.candleRepo, symbol, interval, from, to, 'futures');
    if (dto.autoBackfill !== false && candles.length < expectedBars * 0.9) {
      this.logger.log(
        `合约回测：库内 ${symbol} ${interval} 仅 ${candles.length}/${expectedBars} 根，回填中…`,
      );
      this.setProgress('backfill', 0, `从合约公共接口回填 0/${expectedBars} 根`);
      await backfill(this.candleRepo, symbol, interval, from, to, 'futures', (fetched, expected) => {
        this.setProgress('backfill', (fetched / expected) * 100, `回填 ${fetched}/${expected} 根`);
      });
      candles = await loadRange(this.candleRepo, symbol, interval, from, to, 'futures');
    }
    if (candles.length <= cfg.warmupBars + 2) {
      throw new BusinessException(
        'BAD_REQUEST',
        `合约 K 线数据不足（${candles.length} 根，warmup ${cfg.warmupBars}），无法回测`,
      );
    }

    // 资金费率：库内缺失时回填（公共接口，每 8h 一条）
    this.setProgress('backfill', 90, '加载资金费率…');
    let fundingRates = await loadFundingRange(this.fundingRepo, symbol, from, to);
    if (dto.autoBackfill !== false && fundingRates.length < Math.floor((to - from) / (8 * 3_600_000)) * 0.9) {
      try {
        await backfillFunding(this.fundingRepo, symbol, from, to);
        fundingRates = await loadFundingRange(this.fundingRepo, symbol, from, to);
      } catch (err) {
        // 资金费回填失败不阻断回测：按零费率继续，报告 totalFundingPaid=0 即可归因
        this.logger.warn(`资金费率回填失败，按零费率继续: ${(err as Error).message}`);
        fundingRates = [];
      }
    }
    cfg.fundingRates = fundingRates;

    this.setProgress('compute', 0, `逐根回放 ${candles.length} 根合约 K 线`);
    const runOnce = async (leverage: number): Promise<FuturesBacktestReport> => {
      const report = await runFuturesBacktest(candles, strategy, { ...cfg, leverage }, (done, total) => {
        this.setProgress('compute', (done / total) * 100, `逐根回放 ${done}/${total}`);
      });
      // 对比跑时不再刷进度
      if (leverage === cfg.leverage) {
        const tradesTruncated = report.trades.length > MAX_TRADES;
        return {
          ...report,
          trades: tradesTruncated ? report.trades.slice(-MAX_TRADES) : report.trades,
          equityCurve: downsample(report.equityCurve, MAX_CURVE_POINTS),
          meta: {
            ...report.meta,
            downsampled: report.equityCurve.length > MAX_CURVE_POINTS,
            tradesTruncated,
          },
        };
      }
      return report;
    };

    const main = await runOnce(cfg.leverage);

    if (dto.compareLeverage) {
      // 1x / 3x / 5x 对比：与主报告同数据同策略，只变杠杆（主杠杆若在列表中不重复跑）
      const levels = [1, 3, 5].filter((l) => l !== cfg.leverage);
      const rows: FuturesLeverageRow[] = [
        { leverage: cfg.leverage, ...metricsOf(main) },
        ...(await Promise.all(
          levels.map(async (l) => ({ leverage: l, ...metricsOf(await runOnce(l)) })),
        )),
      ].sort((a, b) => a.leverage - b.leverage);
      return { main, comparison: rows };
    }

    return main;
  }

  /** 归一化公共参数（两市场共用） */
  private normalizeRange(dto: BacktestRequestDto) {
    const symbol = dto.symbol ?? 'BTCUSDT';
    const interval = dto.interval ?? '5m';
    const from = new Date(dto.from).getTime();
    const to = new Date(dto.to).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new BusinessException('BAD_REQUEST', 'from/to 必须是合法日期（ISO 字符串）');
    }
    if (!(from < to)) throw new BusinessException('BAD_REQUEST', 'from 必须早于 to');

    const stepMs = intervalStepMs(interval);
    const expectedBars = Math.floor((to - from) / stepMs) + 1;
    if (expectedBars > MAX_EXPECTED_BARS) {
      throw new BusinessException(
        'BAD_REQUEST',
        `区间过大（约 ${expectedBars} 根，上限 ${MAX_EXPECTED_BARS}）。请缩短区间或改用更大周期`,
      );
    }
    return { symbol, interval, from, to, stepMs, expectedBars };
  }
}

/** 等距下采样（保留首尾），控制 HTTP 响应体积 */
function downsample(points: { time: number; equity: number; drawdownPct: number }[], max: number) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 从合约回测报告提取对比行 */
function metricsOf(report: FuturesBacktestReport): FuturesLeverageRow {
  return {
    leverage: report.meta.leverage,
    totalReturnPct: report.metrics.totalReturnPct,
    annualizedReturnPct: report.metrics.annualizedReturnPct,
    maxDrawdownPct: report.metrics.maxDrawdownPct,
    sharpeRatio: report.metrics.sharpeRatio,
    winRate: report.metrics.winRate,
    profitFactor: report.metrics.profitFactor,
    tradeCount: report.metrics.tradeCount,
    liquidationCount: report.meta.liquidationCount,
    totalFundingPaid: report.meta.totalFundingPaid,
  };
}

function intervalStepMs(interval: Timeframe): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 300_000;
  const n = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 60_000;
  return n * unitMs;
}
