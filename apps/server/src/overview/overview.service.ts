import { Injectable } from '@nestjs/common';
import {
  DEFAULT_SYMBOL,
  DataSourceStatus,
  OverviewDTO,
  PositionSnapshot,
  RecentOrderItem,
} from '@ai-trader/shared';
import { DataSource } from 'typeorm';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { AgentConfigService } from '../agent/agent-config.service';
import { AgentEngine } from '../agent/agent-engine.service';
import { LlmClient } from '../agent/llm.client';
import { AccountService } from '../account/account.service';
import { PositionService } from '../account/position.service';
import { TradingService } from '../trading/trading.service';

@Injectable()
export class OverviewService {
  constructor(
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly agentConfig: AgentConfigService,
    private readonly agent: AgentEngine,
    private readonly llm: LlmClient,
    private readonly accounts: AccountService,
    private readonly trading: TradingService,
    private readonly positions: PositionService,
    private readonly dataSource: DataSource,
  ) {}

  async build(symbol = DEFAULT_SYMBOL): Promise<OverviewDTO> {
    const config = await this.agentConfig.get();
    const entity = await this.agentConfig.getOrCreate();

    const ticker = this.market.getTicker(symbol);
    const marketPulse = this.market.getMarketPulse(symbol);
    const { rows: balances, source: balanceSource } = await this.accounts.getBalances(
      config.mode,
      config.enabledExchanges,
    );
    const pnl = await this.accounts.pnlToday(config.mode, config.enabledExchanges);
    const stats = await this.trading.statsToday();

    const recentOrdersRaw = await this.trading.recent(8);
    const recentOrders: RecentOrderItem[] = recentOrdersRaw.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price,
      quantity: o.quantity,
      status: o.status,
      exchange: o.exchange,
      mode: o.mode,
      createdAt: o.createdAt,
    }));

    const recentDecisions = await this.agent.recent(8);
    const newsResult = await this.news.list({ pageSize: 8 });
    const keywordTrends = await this.news.keywordTrends(10);

    const totals = {
      usdtValue: balances.reduce((acc, r) => acc + r.usdtValue, 0),
      btcAmount: balances
        .filter((r) => r.asset === 'BTC')
        .reduce((acc, r) => acc + r.total, 0),
      pnlToday: pnl.pnl,
      pnlTodayPct: pnl.pct,
      openOrders: stats.open,
      filledToday: stats.filled,
    };

    return {
      ticker,
      mode: config.mode,
      environment: config.mode === 'live' ? 'live' : 'testnet',
      agentEnabled: config.enabled,
      agentRunning: this.agent.isRunning,
      llmAvailable: this.llm.available,
      balances,
      totals,
      marketPulse,
      recentOrders,
      recentDecisions,
      news: newsResult.items,
      keywordTrends,
      dataSources: await this.dataSources(balanceSource),
      updatedAt: new Date().toISOString(),
      // 附加信息：余额来源、最近一次运行时间与持仓快照
      ...({
        balanceSource,
        agentLastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
        position: await this.getPositionSafe(symbol),
      } as Record<string, unknown>),
    } as OverviewDTO;
  }

  /** 持仓推导失败不应拖垮整个概览接口 */
  private async getPositionSafe(symbol: string): Promise<PositionSnapshot | null> {
    try {
      return await this.positions.getPosition(symbol);
    } catch {
      return null;
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
        balanceSource === 'exchange' ? '来自交易所实时查询' : '使用虚拟账户（由历史订单推导）',
    });

    return sources;
  }
}
