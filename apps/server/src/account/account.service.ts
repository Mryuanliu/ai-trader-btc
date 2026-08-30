import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BalanceRow, SPOT_EXCHANGE_CODES, TERMINAL_EMPTY_STATUSES } from '@ai-trader/shared';
import { Between, Repository } from 'typeorm';
import { BalanceSnapshotEntity, OrderEntity } from '../database/entities';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { MarketService } from '../market/market.service';

/** dry-run 模式的初始虚拟本金 */
export const VIRTUAL_INITIAL_USDT = 10_000;
export const VIRTUAL_INITIAL_BTC = 0.05;

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(BalanceSnapshotEntity)
    private readonly snapshotRepo: Repository<BalanceSnapshotEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly registry: ExchangeRegistry,
    private readonly market: MarketService,
  ) {}

  /**
   * 读取账户余额。
   * 优先真实交易所；不可达或 dry-run 模式时回退到虚拟账户（由历史订单推导）。
   */
  async getBalances(
    mode: 'dry_run' | 'testnet' | 'live',
    exchanges: string[],
  ): Promise<{ rows: BalanceRow[]; source: 'exchange' | 'virtual' }> {
    if (mode !== 'dry_run') {
      try {
        const rows: BalanceRow[] = [];
        // 只统计现货交易所：合约钱包余额与现货 USDT 是同一笔资金的两个视图，
        // 若一并计入会重复计算总权益，放大风控的可用额度判断
        for (const code of exchanges) {
          if (!SPOT_EXCHANGE_CODES.includes(code as (typeof SPOT_EXCHANGE_CODES)[number])) {
            continue;
          }
          const adapter = await this.registry.get(code as never);
          if (!adapter.hasCredentials) continue;
          const balances = await adapter.getBalances();
          const price = this.market.getTicker('BTCUSDT').price;
          for (const b of balances) {
            rows.push({
              exchange: adapter.code,
              environment: adapter.environment,
              asset: b.asset,
              free: b.free,
              locked: b.locked,
              total: b.total,
              usdtValue: b.asset === 'USDT' ? b.total : b.asset === 'BTC' ? b.total * price : 0,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        if (rows.length > 0) return { rows, source: 'exchange' };
      } catch (err) {
        this.logger.warn(`读取交易所余额失败，回退虚拟账户: ${(err as Error).message}`);
      }
    }
    return { rows: await this.getVirtualBalances(), source: 'virtual' };
  }

  /**
   * 虚拟账户：由 dry-run 历史成交推导，保证与下单记录自洽。
   *
   * 用 SQL 聚合而非加载全部订单逐行累加——该方法被决策、快照、概览三处高频调用，
   * 此前无 take 限制，订单量增长后会线性变慢。
   */
  async getVirtualBalances(): Promise<BalanceRow[]> {
    const row = await this.orderRepo
      .createQueryBuilder('o')
      .select(
        `COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN -o."quoteAmount" ELSE o."quoteAmount" END), 0)::float8`,
        'usdtDelta',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN o."filledQuantity" ELSE -o."filledQuantity" END), 0)::float8`,
        'btcDelta',
      )
      .where('o.mode = :mode', { mode: 'dry_run' })
      .andWhere('o.status = :status', { status: 'FILLED' })
      // 限定现货：合约成交走保证金模型，混入会把合约盈亏算进现货虚拟本金
      .andWhere('o.market = :market', { market: 'spot' })
      .getRawOne<{ usdtDelta: string; btcDelta: string }>();

    let usdt = VIRTUAL_INITIAL_USDT + Number(row?.usdtDelta ?? 0);
    let btc = VIRTUAL_INITIAL_BTC + Number(row?.btcDelta ?? 0);
    usdt = Math.max(0, usdt);
    btc = Math.max(0, btc);

    const price = this.market.getTicker('BTCUSDT').price || 0;
    const now = new Date().toISOString();
    return [
      {
        exchange: 'binance',
        environment: 'testnet',
        asset: 'USDT',
        free: usdt,
        locked: 0,
        total: usdt,
        usdtValue: usdt,
        updatedAt: now,
      },
      {
        exchange: 'binance',
        environment: 'testnet',
        asset: 'BTC',
        free: btc,
        locked: 0,
        total: btc,
        usdtValue: btc * price,
        updatedAt: now,
      },
    ];
  }

  /** 写入余额快照（供今日盈亏与回撤计算使用） */
  async snapshot(
    rows: BalanceRow[],
    source: 'virtual' | 'exchange',
  ): Promise<BalanceSnapshotEntity[]> {
    if (rows.length === 0) return [];
    const entities = rows.map((row) =>
      this.snapshotRepo.create({
        exchange: row.exchange,
        environment: row.environment,
        asset: row.asset,
        free: row.free,
        locked: row.locked,
        total: row.total,
        usdtValue: row.usdtValue,
        source,
      }),
    );
    return this.snapshotRepo.save(entities);
  }

  /** 当前总权益（USDT 折算），多交易所按资产去重累加 */
  async currentEquity(mode: 'dry_run' | 'testnet' | 'live', exchanges: string[]): Promise<number> {
    const { rows } = await this.getBalances(mode, exchanges);
    return rows.reduce((acc, row) => acc + row.usdtValue, 0);
  }

  /**
   * 今日盈亏：当前权益 - 今日首个快照权益。
   *
   * 只与「同来源」的快照比较：虚拟账户（约 13890）与交易所实读（如 10000）
   * 量级不同，混算会得出巨大的虚假亏损并误触发日亏损熔断。
   */
  async pnlToday(
    mode: 'dry_run' | 'testnet' | 'live',
    exchanges: string[],
  ): Promise<{ pnl: number; pct: number; hasBaseline: boolean }> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const { rows, source } = await this.getBalances(mode, exchanges);
    const current = rows.reduce((acc, row) => acc + row.usdtValue, 0);

    const snapshots = await this.snapshotRepo.find({
      where: { createdAt: Between(start, end), source },
      order: { createdAt: 'ASC' },
      take: 400,
    });
    if (snapshots.length === 0) {
      return { pnl: 0, pct: 0, hasBaseline: false };
    }

    // 取当日最早一批快照（同一秒写入的算一组）
    const firstTs = snapshots[0].createdAt.getTime();
    const baselineRows = snapshots.filter(
      (s) => Math.abs(s.createdAt.getTime() - firstTs) < 5_000,
    );
    const baseline = baselineRows.reduce((acc, row) => acc + Number(row.usdtValue), 0);
    if (baseline <= 0) return { pnl: 0, pct: 0, hasBaseline: false };

    const pnl = current - baseline;
    return { pnl, pct: (pnl / baseline) * 100, hasBaseline: true };
  }

  /**
   * 今日已成交订单数（风控用）。
   *
   * 只统计真正占用风险敞口的订单：已终结且未成交任何数量（CANCELED/REJECTED/
   * EXPIRED/FAILED）不应计入每日笔数上限，否则一次失败重试就会耗尽配额。
   */
  async countOrdersToday(): Promise<number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.orderRepo
      .createQueryBuilder('o')
      .where('o."createdAt" BETWEEN :start AND :end', { start, end: new Date() })
      .andWhere('o.status NOT IN (:...excluded)', {
        excluded: [...TERMINAL_EMPTY_STATUSES],
      })
      // 只统计现货：合约单不应占用现货的每日下单额度
      .andWhere('o.market = :market', { market: 'spot' })
      .getCount();
  }
}
