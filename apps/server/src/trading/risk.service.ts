import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentConfigShape, OrderSide } from '@ai-trader/shared';
import { Between, Repository } from 'typeorm';
import { BalanceSnapshotEntity, OrderEntity, RiskEventEntity, RiskLevel } from '../database/entities';
import { AccountService } from '../account/account.service';
import { PositionService } from '../account/position.service';

export interface RiskContext {
  config: AgentConfigShape;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  quoteAmount: number;
  /** USDT 可用余额 / BTC 可用数量 */
  quoteFree: number;
  baseFree: number;
  /** 余额来源，供回撤统计隔离基线 */
  quoteSource?: 'virtual' | 'exchange';
  source: 'agent' | 'manual';
  confirmToken?: string;
  liveConfirmToken: string;
}

export interface RiskVerdict {
  passed: boolean;
  rejectedBy?: string;
  note?: string;
}

export const RISK_REASONS: Record<string, string> = {
  MIN_ORDER_INTERVAL: '下单过于频繁，未达到最小下单间隔',
  MAX_ORDER_AMOUNT: '单笔金额超过上限',
  MAX_DAILY_ORDERS: '今日下单笔数已达上限',
  DAILY_LOSS_LIMIT: '今日亏损已达上限，停止开仓',
  MAX_DRAWDOWN: '回撤超过阈值，触发熔断',
  INSUFFICIENT_BALANCE: '可用余额不足',
  LIVE_MODE_CONFIRM_REQUIRED: '实盘下单缺少二次确认 Token',
  INVALID_QUANTITY: '下单数量不合法',
};

@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(RiskEventEntity)
    private readonly riskRepo: Repository<RiskEventEntity>,
    @InjectRepository(BalanceSnapshotEntity)
    private readonly snapshotRepo: Repository<BalanceSnapshotEntity>,
    private readonly accounts: AccountService,
    private readonly positions: PositionService,
  ) {}

  /** 所有下单（含手动单）统一经过此守卫 */
  async check(context: RiskContext): Promise<RiskVerdict> {
    const { config } = context;

    if (!(context.quantity > 0)) {
      return this.reject(context, 'INVALID_QUANTITY', '下单数量必须大于 0');
    }

    if (config.mode === 'live') {
      if (!context.confirmToken || context.confirmToken !== context.liveConfirmToken) {
        return this.reject(
          context,
          'LIVE_MODE_CONFIRM_REQUIRED',
          '实盘模式需要携带正确的二次确认 Token',
        );
      }
    }

    if (config.maxOrderAmount > 0 && context.quoteAmount > config.maxOrderAmount) {
      return this.reject(
        context,
        'MAX_ORDER_AMOUNT',
        `单笔金额 ${context.quoteAmount.toFixed(2)} 超过上限 ${config.maxOrderAmount}`,
      );
    }

    const lastOrder = await this.orderRepo.findOne({
      where: { symbol: context.symbol },
      order: { createdAt: 'DESC' },
    });
    if (lastOrder && config.minOrderIntervalSec > 0) {
      const elapsed = (Date.now() - lastOrder.createdAt.getTime()) / 1000;
      if (elapsed < config.minOrderIntervalSec) {
        return this.reject(
          context,
          'MIN_ORDER_INTERVAL',
          `距离上一单仅 ${elapsed.toFixed(0)}s，需等待 ${config.minOrderIntervalSec}s`,
        );
      }
    }

    const todayCount = await this.accounts.countOrdersToday();
    if (config.maxDailyOrders > 0 && todayCount >= config.maxDailyOrders) {
      return this.reject(
        context,
        'MAX_DAILY_ORDERS',
        `今日已下单 ${todayCount} 笔，达到上限 ${config.maxDailyOrders}`,
      );
    }

    const { pnl, hasBaseline } = await this.accounts.pnlToday(
      config.mode,
      config.enabledExchanges,
    );
    if (hasBaseline && config.dailyLossLimit > 0 && pnl <= -config.dailyLossLimit) {
      return this.reject(
        context,
        'DAILY_LOSS_LIMIT',
        `今日已亏损 ${pnl.toFixed(2)} USDT，达到上限 ${config.dailyLossLimit}`,
      );
    }

    if (config.maxDrawdownPct > 0) {
      const drawdown = await this.currentDrawdownPct(
        context.quoteSource === 'exchange' ? 'exchange' : 'virtual',
      );
      if (drawdown > config.maxDrawdownPct) {
        return this.reject(
          context,
          'MAX_DRAWDOWN',
          `当前回撤 ${drawdown.toFixed(2)}%，超过阈值 ${config.maxDrawdownPct}%`,
        );
      }
    }

    if (context.side === 'BUY' && context.quoteAmount > context.quoteFree) {
      return this.reject(
        context,
        'INSUFFICIENT_BALANCE',
        `可用 USDT ${context.quoteFree.toFixed(2)}，不足以支付 ${context.quoteAmount.toFixed(2)}`,
      );
    }

    // 买入还需校验集中度：原逻辑只看「单笔金额」和「余额是否够」，
    // 连续加仓可以一直买到 USDT 耗尽，等于把全部资金压在单一标的上。
    if (context.side === 'BUY') {
      const exposure = await this.computeExposurePct(context);
      if (exposure !== null && exposure > config.maxExposurePct) {
        return this.reject(
          context,
          'MAX_EXPOSURE',
          `买入后 ${context.symbol} 持仓占比将达 ${exposure.toFixed(2)}%，` +
            `超过上限 ${config.maxExposurePct}%`,
        );
      }
    }
    if (context.side === 'SELL' && context.quantity > context.baseFree) {
      return this.reject(
        context,
        'INSUFFICIENT_BALANCE',
        `可用 BTC ${context.baseFree.toFixed(6)}，不足以卖出 ${context.quantity.toFixed(6)}`,
      );
    }

    return { passed: true, note: '风控校验通过' };
  }

  /**
   * 计算「本次买入后」该标的持仓市值占总权益的百分比。
   * 返回 null 表示总权益无法取得，此时不因敞口拦单（避免误伤）。
   */
  private async computeExposurePct(context: RiskContext): Promise<number | null> {
    try {
      const position = await this.positions.getPosition(context.symbol);
      const totalEquity = await this.accounts.currentEquity(
        context.config.mode,
        context.config.enabledExchanges,
      );
      if (!(totalEquity > 0)) return null;

      // 现仓市值 + 本次买入金额，再除以总权益
      const afterValue = position.marketValue + context.quoteAmount;
      return (afterValue / totalEquity) * 100;
    } catch (err) {
      this.logger.warn(`计算持仓敞口失败，跳过该项校验: ${(err as Error).message}`);
      return null;
    }
  }

  private async reject(
    context: RiskContext,
    code: string,
    note: string,
  ): Promise<RiskVerdict> {
    const reason = RISK_REASONS[code] ?? code;
    this.logger.warn(`[风控拦截][${code}] ${context.symbol} ${context.side} - ${note}`);
    await this.record('limit', 'warn', `${reason}：${note}`, context.symbol);
    return { passed: false, rejectedBy: code, note: `${reason}：${note}` };
  }

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
