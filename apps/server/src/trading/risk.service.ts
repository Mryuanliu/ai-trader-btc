import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentConfigShape, OrderSide } from '@ai-trader/shared';
import { Between, Repository } from 'typeorm';
import { BalanceSnapshotEntity, OrderEntity, RiskEventEntity, RiskLevel } from '../database/entities';
import { AccountService } from '../account/account.service';

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
    if (context.side === 'SELL' && context.quantity > context.baseFree) {
      return this.reject(
        context,
        'INSUFFICIENT_BALANCE',
        `可用 BTC ${context.baseFree.toFixed(6)}，不足以卖出 ${context.quantity.toFixed(6)}`,
      );
    }

    return { passed: true, note: '风控校验通过' };
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

  /** 今日最大回撤（%），仅统计当前账户来源，避免跨口径误判 */
  async currentDrawdownPct(source: 'virtual' | 'exchange' = 'virtual'): Promise<number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const snapshots = await this.snapshotRepo.find({
      where: { createdAt: Between(start, new Date()), source },
      order: { createdAt: 'ASC' },
      take: 2000,
      select: ['createdAt', 'usdtValue'],
    });
    if (snapshots.length < 2) return 0;

    // 按写入时间归组求和，得到权益曲线
    const equityPoints: number[] = [];
    let bucketTime = 0;
    let bucketSum = 0;
    for (const snap of snapshots) {
      const ts = snap.createdAt.getTime();
      if (ts - bucketTime > 5_000) {
        if (bucketTime > 0) equityPoints.push(bucketSum);
        bucketTime = ts;
        bucketSum = 0;
      }
      bucketSum += Number(snap.usdtValue);
    }
    equityPoints.push(bucketSum);
    if (equityPoints.length < 2) return 0;

    let peak = equityPoints[0];
    let maxDrawdown = 0;
    for (const value of equityPoints) {
      peak = Math.max(peak, value);
      if (peak > 0) {
        maxDrawdown = Math.max(maxDrawdown, ((peak - value) / peak) * 100);
      }
    }
    return maxDrawdown;
  }
}
