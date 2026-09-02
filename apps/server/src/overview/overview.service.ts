import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_SYMBOL,
  BalanceRow,
  DataSourceStatus,
  ExchangeCode,
  FuturesPositionSnapshot,
  OverviewDTO,
  RecentOrderItem,
  RoundTrip,
} from '@ai-trader/shared';
import { DataSource } from 'typeorm';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { FuturesEngine } from '../futures/futures-engine.service';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { LlmClient } from '../agent/llm.client';
import { PositionService } from '../account/position.service';
import { TradingService } from '../trading/trading.service';
import { FuturesPositionService } from '../futures/futures-position.service';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';

/** 今日 00:00 的时间戳 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);

  constructor(
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly futures: FuturesEngine,
    private readonly futuresTrading: FuturesTradingService,
    private readonly llm: LlmClient,
    private readonly trading: TradingService,
    private readonly positions: PositionService,
    private readonly futuresPositions: FuturesPositionService,
    private readonly registry: ExchangeRegistry,
    private readonly dataSource: DataSource,
  ) {}

  async build(symbol = DEFAULT_SYMBOL): Promise<OverviewDTO> {
    const config = await this.futuresConfig.get();
    const entity = await this.futuresConfig.getEntity();

    const ticker = this.market.getTicker(symbol);
    const marketPulse = this.market.getMarketPulse(symbol);
    const { rows: balances, source: balanceSource } = await this.getBalancesSafe(config.mode);
    const stats = await this.trading.statsToday();

    // 回合盈亏按「全部标的」取：既用于今日已实现盈亏，也用于给近期订单逐行标注，
    // 且订单里可能出现任意交易对，不能只取当前 symbol。一次查询两处复用。
    const [futuresTrips, futuresPositions] = await Promise.all([
      this.positions.getRoundTrips(),
      this.getFuturesPositionsSafe(),
    ]);
    const trips: RoundTrip[] = futuresTrips.trips;

    // 今日盈亏 = 已实现（今日平仓回合）+ 浮动（当前合约持仓，交易所口径）
    const pnlBreakdown = buildPnlBreakdown({
      trips,
      fillCount: futuresTrips.fillCount,
      futuresPositions,
    });
    const pnlByOrder = buildPnlByOrder(trips);

    const recentOrdersRaw = await this.trading.recent(8, 'futures');
    const recentOrders: RecentOrderItem[] = recentOrdersRaw.map((o) => {
      const hit = pnlByOrder.get(o.id);
      return {
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        price: o.price,
        quantity: o.quantity,
        status: o.status,
        exchange: o.exchange,
        mode: o.mode,
        market: o.market,
        filledPrice: o.filledPrice,
        quoteAmount: o.quoteAmount,
        // 只有平仓单才配对得到回合；开仓单没有盈亏概念
        roundTripPnl: hit ? hit.netPnl : null,
        roundTripReturnPct: hit ? hit.returnPct : null,
        createdAt: o.createdAt,
      };
    });

    const recentDecisions = await this.futures.list({ limit: 8 });
    const newsResult = await this.news.list({ pageSize: 8 });
    const keywordTrends = await this.news.keywordTrends(10);

    const usdtValue = balances.reduce((acc, r) => acc + r.usdtValue, 0);
    // 起始权益 = 当前权益 − 今日盈亏，用于把盈亏换算成收益率；
    // 与盈亏同源，避免再依赖可能缺失的余额快照
    const startEquity = usdtValue - pnlBreakdown.pnlToday;
    const totals = {
      usdtValue,
      btcAmount: balances
        .filter((r) => r.asset === 'BTC')
        .reduce((acc, r) => acc + r.total, 0),
      pnlToday: pnlBreakdown.pnlToday,
      pnlTodayPct: startEquity > 0 ? (pnlBreakdown.pnlToday / startEquity) * 100 : 0,
      realizedPnlToday: pnlBreakdown.realizedPnlToday,
      unrealizedPnlToday: pnlBreakdown.unrealizedPnlToday,
      hasPnlBaseline: pnlBreakdown.hasBaseline,
      openOrders: 0,
      filledToday: 0,
      futuresOpenOrders: stats.byMarket.futures.open,
      futuresFilledToday: stats.byMarket.futures.filled,
    };

    return {
      ticker,
      mode: config.mode,
      environment: config.mode === 'live' ? 'live' : 'testnet',
      agentEnabled: config.enabled,
      agentRunning: this.futures.isRunning,
      llmAvailable: this.llm.available,
      balances,
      totals,
      marketPulse,
      recentOrders,
      recentDecisions: recentDecisions.map((d) => ({ ...d })),
      news: newsResult.items,
      keywordTrends,
      dataSources: await this.dataSources(balanceSource),
      updatedAt: new Date().toISOString(),
      // 附加信息：余额来源、最近一次运行时间（现货 position 字段已随现货移除）
      ...({
        balanceSource,
        agentLastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
      } as Record<string, unknown>),
    } as OverviewDTO;
  }

  /**
   * 合约账户余额。
   *
   * 真实模式读合约钱包（币安 fapi account）；dry_run 用合约可用保证金构造单行虚拟 USDT。
   * 读取失败按空处理不拖垮概览——前端对空 balances 显示 `--`。
   */
  private async getBalancesSafe(
    mode: 'dry_run' | 'testnet' | 'live',
  ): Promise<{ rows: BalanceRow[]; source: 'exchange' | 'virtual' }> {
    const now = new Date().toISOString();
    try {
      if (mode !== 'dry_run') {
        const adapter = await this.registry.get('binance-futures');
        if (adapter.hasCredentials) {
          const rows: BalanceRow[] = (await adapter.getBalances()).map((b) => ({
            exchange: adapter.code as ExchangeCode,
            environment: adapter.environment,
            asset: b.asset,
            free: b.free,
            locked: b.locked,
            total: b.total,
            usdtValue: b.asset === 'USDT' ? b.total : 0,
            updatedAt: now,
          }));
          if (rows.length > 0) return { rows, source: 'exchange' };
        }
      }
      // dry_run（或交易所读取失败）：合约可用保证金作为虚拟权益展示
      const margin = await this.futuresTrading.getAvailableMargin();
      return {
        rows: [
          {
            exchange: 'binance-futures',
            environment: mode === 'live' ? 'live' : 'testnet',
            asset: 'USDT',
            free: margin,
            locked: 0,
            total: margin,
            usdtValue: margin,
            updatedAt: now,
          },
        ],
        source: 'virtual',
      };
    } catch (err) {
      this.logger.warn(`读取合约余额失败，按空处理: ${(err as Error).message}`);
      return { rows: [], source: 'virtual' };
    }
  }

  /** 合约持仓读取失败（未配置密钥/网络不可达）时按无持仓处理，不拖垮概览 */
  private async getFuturesPositionsSafe(): Promise<FuturesPositionSnapshot[]> {
    try {
      const rows = await this.futuresPositions.listPositions();
      return rows.filter((r) => Math.abs(r.quantity) > 0);
    } catch (err) {
      this.logger.debug(`读取合约持仓失败，按无持仓处理: ${(err as Error).message}`);
      return [];
    }
  }

  private async dataSources(
    balanceSource: 'exchange' | 'virtual',
  ): Promise<DataSourceStatus[]> {
    const sources: DataSourceStatus[] = [];

    const dbStart = Date.now();
    let dbOk = true;
    let dbMessage = '正常';
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      dbOk = false;
      dbMessage = (err as Error).message;
    }
    sources.push({
      name: 'postgres',
      label: 'PostgreSQL',
      ok: dbOk,
      message: dbMessage,
      latencyMs: Date.now() - dbStart,
    });

    const marketStatus = this.market.status;
    sources.push({
      name: 'market',
      label: '行情源',
      ok: marketStatus.source === 'live',
      message:
        marketStatus.source === 'live'
          ? `已连接实时行情（WebSocket ${marketStatus.wsConnected ? '在线' : '待建立'}）`
          : '外部行情不可达，正在使用模拟数据',
    });

    sources.push({
      name: 'llm',
      label: '大模型',
      ok: this.llm.available,
      message: this.llm.available ? '已配置模型密钥' : '未配置密钥，决策降级为纯指标',
    });

    const newsCount = await this.news.sources$();
    const total = newsCount.reduce((acc, r) => acc + r.count, 0);
    sources.push({
      name: 'news',
      label: '新闻源',
      ok: total > 0,
      message: total > 0 ? `已收录 ${total} 条新闻` : '暂无新闻',
    });

    sources.push({
      name: 'balance',
      label: '账户余额',
      ok: true,
      message:
        balanceSource === 'exchange' ? '来自合约钱包实时查询' : '使用虚拟保证金（dry-run 模拟）',
    });

    return sources;
  }
}

/**
 * 今日盈亏 = 已实现（今日平仓回合）+ 浮动（合约持仓，交易所 unrealizedProfit）。
 *
 * 口径要点：
 * - 已实现取回合净盈亏，与订单页「回合盈亏」同源同口径（已扣手续费）
 * - 合约浮动取交易所 positionRisk 的 unrealizedProfit（本地无法还原保证金与资金费）
 * - hasBaseline：既无成交也无持仓时，盈亏没有数据支撑，前端应展示 `--` 而非 0
 */
export function buildPnlBreakdown(input: {
  trips: RoundTrip[];
  fillCount: number;
  futuresPositions: FuturesPositionSnapshot[];
}): {
  realizedPnlToday: number;
  unrealizedPnlToday: number;
  pnlToday: number;
  hasBaseline: boolean;
} {
  const todayStart = startOfToday();

  const realizedPnlToday = input.trips
    .filter((t) => t.closedAt >= todayStart)
    .reduce((acc, t) => acc + t.netPnl, 0);

  const unrealizedPnlToday = input.futuresPositions.reduce((acc, p) => acc + p.unrealizedPnl, 0);

  const holdingQty = input.futuresPositions.reduce((acc, p) => acc + Math.abs(p.quantity), 0);

  return {
    realizedPnlToday: Number(realizedPnlToday.toFixed(8)),
    unrealizedPnlToday: Number(unrealizedPnlToday.toFixed(8)),
    pnlToday: Number((realizedPnlToday + unrealizedPnlToday).toFixed(8)),
    hasBaseline: input.fillCount > 0 || holdingQty > 0,
  };
}

/** 平仓订单 ID → 该回合的净盈亏，供近期订单逐行标注（开仓单不在表内） */
function buildPnlByOrder(
  trips: RoundTrip[],
): Map<string, { netPnl: number; returnPct: number }> {
  const map = new Map<string, { netPnl: number; returnPct: number }>();
  for (const t of trips) {
    if (!t.closeOrderId) continue;
    map.set(t.closeOrderId, { netPnl: t.netPnl, returnPct: t.returnPct });
  }
  return map;
}
