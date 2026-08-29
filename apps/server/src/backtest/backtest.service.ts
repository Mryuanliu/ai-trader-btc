import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { strategyRegistry, type Candle, type Timeframe } from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { MarketCandleEntity } from '../database/entities';
import { BusinessException } from '../common/business.exception';
import { backfill, loadRange } from './candle-source';
import { runBacktest } from './engine';
import type { BacktestConfig, BacktestReport } from './types';

/** 区间应有根数上限：HTTP 同步回测防止拉取/计算过量 */
const MAX_EXPECTED_BARS = 60_000;
/** 报告 equityCurve 下采样上限，控制响应体积 */
const MAX_CURVE_POINTS = 2_000;

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
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  /** 防止并发回测打爆 DB / 交易所 */
  private running = false;

  constructor(
    @InjectRepository(MarketCandleEntity)
    private readonly candleRepo: Repository<MarketCandleEntity>,
  ) {}

  async run(dto: BacktestRequestDto): Promise<BacktestReport> {
    if (this.running) {
      throw new BusinessException('BAD_REQUEST','已有回测在运行中，请稍后再试');
    }
    this.running = true;
    try {
      return await this.doRun(dto);
    } finally {
      this.running = false;
    }
  }

  private async doRun(dto: BacktestRequestDto): Promise<BacktestReport> {
    const symbol = dto.symbol ?? 'BTCUSDT';
    const interval = dto.interval ?? '5m';
    const from = new Date(dto.from).getTime();
    const to = new Date(dto.to).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new BusinessException('BAD_REQUEST','from/to 必须是合法日期（ISO 字符串）');
    }
    if (!(from < to)) throw new BusinessException('BAD_REQUEST','from 必须早于 to');

    const stepMs = intervalStepMs(interval);
    const expectedBars = Math.floor((to - from) / stepMs) + 1;
    if (expectedBars > MAX_EXPECTED_BARS) {
      throw new BusinessException('BAD_REQUEST',
        `区间过大（约 ${expectedBars} 根，上限 ${MAX_EXPECTED_BARS}）。请缩短区间或改用更大周期`,
      );
    }

    const { strategy, fellBack } = strategyRegistry.getOrDefault(dto.strategyName ?? 'trend_following');
    if (fellBack) throw new BusinessException('BAD_REQUEST',`策略 ${dto.strategyName} 不存在`);

    const config: BacktestConfig = {
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
    };

    let candles = await loadRange(this.candleRepo, symbol, interval, from, to);
    if (dto.autoBackfill !== false && candles.length < expectedBars * 0.9) {
      this.logger.log(
        `HTTP 回测：库内 ${symbol} ${interval} 仅 ${candles.length}/${expectedBars} 根，回填中…`,
      );
      await backfill(this.candleRepo, symbol, interval, from, to);
      candles = await loadRange(this.candleRepo, symbol, interval, from, to);
    }
    if (candles.length <= config.warmupBars + 2) {
      throw new BusinessException('BAD_REQUEST',
        `K 线数据不足（${candles.length} 根，warmup ${config.warmupBars}），无法回测`,
      );
    }

    const report = runBacktest(candles, strategy, config);
    return {
      ...report,
      equityCurve: downsample(report.equityCurve, MAX_CURVE_POINTS),
      meta: { ...report.meta, downsampled: report.equityCurve.length > MAX_CURVE_POINTS },
    };
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

function intervalStepMs(interval: Timeframe): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 300_000;
  const n = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 60_000;
  return n * unitMs;
}
