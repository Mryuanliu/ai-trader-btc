import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { BalanceSnapshotEntity, RiskEventEntity, RiskLevel } from '../database/entities';

/**
 * 风控事件服务（通用层）。
 *
 * 仅合约模式下，本服务只承担三件事：
 * 1. `record`   —— 写入 risk_events（合约风控 FuturesRiskService 有自己的实现，这里供撤单等通用层留痕）
 * 2. `list`     —— 风控事件流水查询（前端风控面板）
 * 3. `currentDrawdownPct` —— 今日最大回撤（基于 balance_snapshots 权益曲线，SQL 窗口函数）
 *
 * 原现货风控 `check`（余额/敞口/单量/日亏/实盘确认）已随现货链路移除；
 * 合约的下单前校验在 `futures/futures-risk.service.ts`（杠杆/保证金/强平距离/minNotional）。
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @InjectRepository(RiskEventEntity)
    private readonly riskRepo: Repository<RiskEventEntity>,
    @InjectRepository(BalanceSnapshotEntity)
    private readonly snapshotRepo: Repository<BalanceSnapshotEntity>,
  ) {}

  async record(
    type: string,
    level: RiskLevel,
    message: string,
    symbol = '',
    decisionId: string | null = null,
    meta: Record<string, unknown> | null = null,
  ): Promise<RiskEventEntity> {
    return this.riskRepo.save(
      this.riskRepo.create({ type, level, message, symbol, decisionId, meta }),
    );
  }

  async list(params: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));
    const [rows, total] = await this.riskRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        level: r.level,
        message: r.message,
        symbol: r.symbol,
        decisionId: r.decisionId,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 今日最大回撤（%），仅统计当前账户来源，避免跨口径误判。
   *
   * 整个计算下沉到 SQL：先用窗口函数把同一批写入的快照归组求和得到权益曲线，
   * 再对曲线求前缀最大值并计算最大回落。
   *
   * 此前是把 `take: 2000` 的行拉进内存遍历，而快照按 60s 写入、每次 2 条，
   * 一天约 2880 行——运行约 14 小时后 ASC 排序只会取到当天前 2000 行，
   * 后半段的回撤被静默忽略，熔断形同虚设。改为 SQL 聚合后不存在该上限。
   */
  async currentDrawdownPct(source: 'virtual' | 'exchange' = 'virtual'): Promise<number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    // 两段式聚合：
    // 1) buckets —— 按秒归组求和，得到权益曲线。快照是整批写入的（同一批时间戳相同），
    //    因此按秒归组与「一次快照 = 一个权益点」严格对齐。
    //    注意不能用固定 5 秒窗口：那会在窗口边界切出不完整分桶（末桶可能只剩 1 行），
    //    实测会把真实 20% 的回撤误算成 84%，直接误触发熔断。
    // 2) peaks   —— 对权益曲线求前缀最大值，再算出最大回落。
    // 全程在库内完成，单次查询只返回一个标量，不存在行数上限。
    const row = await this.snapshotRepo.query(
      `WITH buckets AS (
         SELECT date_trunc('second', s."createdAt") AS bucket,
                SUM(s."usdtValue")::float8 AS equity
         FROM balance_snapshots s
         WHERE s."createdAt" BETWEEN $1 AND $2
           AND s.source = $3
         GROUP BY 1
       ),
       peaks AS (
         SELECT equity,
                MAX(equity) OVER (
                  ORDER BY bucket
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS peak
         FROM buckets
       )
       SELECT COALESCE(
                MAX(CASE WHEN peak > 0 THEN (peak - equity) / peak * 100 ELSE 0 END),
                0
              )::float8 AS drawdown,
              COUNT(*)::int AS points
       FROM peaks`,
      [start, new Date(), source],
    );

    const result = Array.isArray(row) ? row[0] : row;
    // 只有一个权益点时无法计算回落
    if (!result || Number(result.points) < 2) return 0;
    return Number(result.drawdown) || 0;
  }
}
