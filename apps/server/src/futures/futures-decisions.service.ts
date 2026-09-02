import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BlockingReasonCode, DecisionLane, DecisionRecord } from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { normalizePagination, toPageResult } from '../common/pagination';

/**
 * 合约决策查询服务（读 agent_decisions，market='futures' 硬隔离）。
 *
 * 提供决策页所需的三类查询：分页列表、链路统计、阻塞原因诊断聚合。
 * 存量 market='spot' 的历史决策保留在库内作审计，但不再对外查询。
 */
@Injectable()
export class FuturesDecisionsService {
  constructor(
    @InjectRepository(AgentDecisionEntity)
    private readonly decisionRepo: Repository<AgentDecisionEntity>,
  ) {}

  /** 分页决策列表（支持动作/链路/仅成交/关键词筛选） */
  async page(params: {
    page?: number;
    pageSize?: number;
    action?: string;
    executedOnly?: boolean;
    keyword?: string;
    lane?: string;
  }) {
    const { page, pageSize, skip, take } = normalizePagination(params);
    const qb = this.decisionRepo
      .createQueryBuilder('d')
      .where('d.market = :market', { market: 'futures' });

    if (params.action && params.action !== 'ALL') {
      qb.andWhere('d.action = :action', { action: params.action });
    }
    if (params.lane && params.lane !== 'ALL') {
      // 存量 lane='llm' 已废弃，查询时归一进 strategy 口径
      qb.andWhere('d.lane = :lane', { lane: params.lane });
    }
    if (params.executedOnly) {
      qb.andWhere('d.orderId IS NOT NULL');
    }
    if (params.keyword) {
      qb.andWhere('(d.reason ILIKE :kw OR d.symbol ILIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }

    qb.orderBy('d.createdAt', 'DESC').skip(skip).take(take);
    const [rows, total] = await qb.getManyAndCount();
    return toPageResult(rows.map((r) => this.toSummary(r)), total, page, pageSize);
  }

  /**
   * 决策详情（供前端抽屉 DecisionTimeline 展开）。
   *
   * 返回完整的 `DecisionRecord` 结构：把实体的平铺字段（riskPassed/riskRejectedBy/riskNote）
   * 映射为前端期望的 `risk: { passed, rejectedBy, note }` 嵌套对象，
   * 否则 DecisionTimeline 里 `risk.passed` 会因 risk 为 undefined 而崩溃。
   */
  async detail(id: string): Promise<DecisionRecord | null> {
    const row = await this.decisionRepo.findOne({ where: { id } });
    if (!row || row.market !== 'futures') return null;
    return {
      id: row.id,
      agentId: row.agentId,
      symbol: row.symbol,
      action: row.action,
      confidence: row.confidence,
      proximity: row.proximity,
      blockingReason: row.blockingReason,
      diagnostics: row.diagnostics,
      reason: row.reason,
      riskNotes: row.riskNotes,
      inputSnapshot: row.inputSnapshot,
      prompt: row.prompt,
      llmRaw: row.llmRaw,
      llmReasoning: row.llmReasoning,
      llmModel: row.llmModel,
      llmUsage: row.llmUsage,
      lane: row.lane === 'hybrid' ? ('hybrid' as const) : ('strategy' as const),
      strategyName: row.strategyName,
      degraded: row.degraded,
      degradeReason: row.degradeReason,
      risk: {
        passed: row.riskPassed,
        rejectedBy: row.riskRejectedBy ?? undefined,
        note: row.riskNote ?? undefined,
      },
      orderId: row.orderId,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 链路统计：按 lane 分组的决策量、降级量与动作分布（近 N 天，默认 7） */
  async laneStats(days = 7) {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 3_600_000);
    const rows = await this.decisionRepo
      .createQueryBuilder('d')
      .select('d.lane', 'lane')
      .addSelect('d.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(CASE WHEN d.degraded THEN 1 ELSE 0 END)', 'degraded')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .groupBy('d.lane')
      .addGroupBy('d.action')
      .getRawMany<{ lane: DecisionLane; action: string; count: string; degraded: string }>();

    const laneMap = new Map<'strategy' | 'hybrid', { count: number; degraded: number; buys: number; sells: number; holds: number }>();
    for (const r of rows) {
      const lane = (r.lane === 'hybrid' ? 'hybrid' : 'strategy') as 'strategy' | 'hybrid';
      const agg = laneMap.get(lane) ?? { count: 0, degraded: 0, buys: 0, sells: 0, holds: 0 };
      const n = Number(r.count) || 0;
      agg.count += n;
      agg.degraded += Number(r.degraded) || 0;
      if (r.action === 'BUY') agg.buys += n;
      else if (r.action === 'SELL') agg.sells += n;
      else agg.holds += n;
      laneMap.set(lane, agg);
    }
    const lanes = [...laneMap.entries()].map(([lane, v]) => ({ lane, ...v }));
    return {
      total: lanes.reduce((acc, l) => acc + l.count, 0),
      degradedTotal: lanes.reduce((acc, l) => acc + l.degraded, 0),
      lanes,
    };
  }

  /**
   * 决策诊断聚合（近 N 小时，默认 24）：回答「为什么没开单」。
   *
   * 返回与前端 DecisionDiagnosticsPanel 匹配的完整结构：
   * - total / holdTotal：总决策与观望数
   * - topReasons：阻塞原因 Top（含占比 share）
   * - proximityBuckets：观望的接近度分布（0-0.2 ~ 0.8-1.0 五档）
   * - nearMisses：最接近触发的观望（差一点就开仓），含逐信号贡献归因
   * - signalStats：各信号投票率（中/多/空占比），暴露弃权稀释问题
   */
  async diagnostics(windowHours = 24) {
    const since = new Date(Date.now() - Math.max(1, windowHours) * 3_600_000);

    // 1) 阻塞原因 Top（含占比）
    const reasonRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select('d."blockingReason"', 'code')
      .addSelect('COUNT(*)', 'count')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .andWhere('d."blockingReason" IS NOT NULL')
      .groupBy('d."blockingReason"')
      .orderBy('count', 'DESC')
      .getRawMany<{ code: BlockingReasonCode; count: string }>();

    // 2) 总量与观望数
    const totalRow = await this.decisionRepo
      .createQueryBuilder('d')
      .select('COUNT(*)', 'total')
      .addSelect('SUM(CASE WHEN d.action = \'HOLD\' THEN 1 ELSE 0 END)', 'holds')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .getRawOne<{ total: string; holds: string }>();

    const total = Number(totalRow?.total ?? 0);
    const holdTotal = Number(totalRow?.holds ?? 0);

    const reasonCount = reasonRows.reduce((acc, r) => acc + Number(r.count) || 0, 0);
    const topReasons = reasonRows.map((r) => {
      const count = Number(r.count) || 0;
      return { code: r.code, count, share: total > 0 ? count / total : 0 };
    });

    // 3) 观望的接近度分布（拉出近窗口内全部观望决策的 proximity，在内存分桶）
    const holdRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select('d.proximity', 'proximity')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .andWhere('d.action = :action', { action: 'HOLD' })
      .getRawMany<{ proximity: number | null }>();

    const buckets: { bucket: string; min: number; max: number; count: number }[] = [
      { bucket: '0 ~ 0.2', min: 0, max: 0.2, count: 0 },
      { bucket: '0.2 ~ 0.4', min: 0.2, max: 0.4, count: 0 },
      { bucket: '0.4 ~ 0.6', min: 0.4, max: 0.6, count: 0 },
      { bucket: '0.6 ~ 0.8', min: 0.6, max: 0.8, count: 0 },
      { bucket: '0.8 ~ 1.0', min: 0.8, max: 1.0, count: 0 },
    ];
    for (const r of holdRows) {
      if (r.proximity == null) continue;
      const p = r.proximity;
      const b = buckets.find((b) => p >= b.min && p < b.max) ?? buckets[buckets.length - 1];
      b.count += 1;
    }
    const proximityBuckets = buckets.filter((b) => b.count > 0);

    // 4) 最接近触发的观望（proximity 最高前 8 条，带信号贡献归因）
    // 注意：不用 .select(...) 限制列，否则带引号的列名（d."createdAt" 等）会返回原始 DB 列名
    // 而非实体属性，getMany() 映射后 createdAt/diagnostics 等属性会缺失 → toISOString 报错。
    // 直接查完整实体（多取几列无妨，诊断非热路径）。
    const nearMissRows = await this.decisionRepo
      .createQueryBuilder('d')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .andWhere('d.action = :action', { action: 'HOLD' })
      .andWhere('d.proximity IS NOT NULL')
      .orderBy('d.proximity', 'DESC')
      .take(8)
      .getMany();

    const nearMisses = nearMissRows.map((r) => {
      const diag = (r.diagnostics ?? {}) as {
        requiredScore?: number;
        contributions?: { name: string; label: string; bias: string; weight: number; signed: number }[];
      };
      const snapshot = (r.inputSnapshot ?? {}) as { indicatorScore?: number };
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        proximity: r.proximity,
        blockingReason: r.blockingReason,
        score: snapshot.indicatorScore ?? null,
        requiredScore: diag.requiredScore ?? null,
        contributions: (diag.contributions ?? []).map((c) => ({
          name: c.name,
          label: c.label,
          bias: c.bias === 'bullish' ? 'bullish' : c.bias === 'bearish' ? 'bearish' : 'neutral',
          weight: c.weight,
          signed: c.signed,
        })),
      };
    });

    // 5) 信号投票率：从各决策的 diagnostics.contributions 聚合三率
    const signalRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select('d.diagnostics', 'diagnostics')
      .where('d.market = :market', { market: 'futures' })
      .andWhere('d."createdAt" >= :since', { since })
      .andWhere('d.diagnostics IS NOT NULL')
      .getRawMany<{ diagnostics: unknown }>();

    const voteMap = new Map<
      string,
      { name: string; label: string; neutral: number; bull: number; bear: number }
    >();
    for (const row of signalRows) {
      const diag = row.diagnostics as {
        contributions?: { name: string; label: string; bias: string }[];
      };
      for (const c of diag?.contributions ?? []) {
        const agg = voteMap.get(c.name) ?? { name: c.name, label: c.label, neutral: 0, bull: 0, bear: 0 };
        if (c.bias === 'bullish') agg.bull += 1;
        else if (c.bias === 'bearish') agg.bear += 1;
        else agg.neutral += 1;
        voteMap.set(c.name, agg);
      }
    }
    const signalStats = [...voteMap.values()].map((s) => {
      const total = s.neutral + s.bull + s.bear;
      return {
        name: s.name,
        label: s.label,
        total,
        neutralRate: total > 0 ? s.neutral / total : 0,
        bullishRate: total > 0 ? s.bull / total : 0,
        bearishRate: total > 0 ? s.bear / total : 0,
      };
    });

    return {
      windowHours,
      total,
      holdTotal,
      topReasons,
      proximityBuckets,
      nearMisses,
      signalStats,
      // 兼容旧字段（buys/sells/avgProximity 保留，前端未用但避免破坏）
      buys: 0,
      sells: 0,
      avgProximity: null,
      reasonCount,
    };
  }

  private toSummary(r: AgentDecisionEntity) {
    return {
      id: r.id,
      symbol: r.symbol,
      action: r.action,
      confidence: r.confidence,
      proximity: r.proximity,
      blockingReason: r.blockingReason,
      reason: r.reason,
      lane: r.lane === 'hybrid' ? ('hybrid' as const) : ('strategy' as const),
      strategyName: r.strategyName ?? null,
      degraded: r.degraded,
      degradeReason: r.degradeReason ?? null,
      riskPassed: r.riskPassed,
      riskRejectedBy: r.riskRejectedBy,
      orderId: r.orderId,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt.toISOString(),
      llmModel: r.llmModel ?? null,
      llmReasoning: r.llmReasoning ?? null,
      llmUsage: r.llmUsage ?? null,
    };
  }
}
