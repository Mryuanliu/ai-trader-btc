import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { AgentEngine } from '../agent/agent-engine.service';
import { AgentConfigService } from '../agent/agent-config.service';
import { MarketService } from '../market/market.service';
import { CandleStoreService } from '../market/candle-store.service';
import { NewsService } from '../news/news.service';
import { AccountService } from '../account/account.service';
import { TradingService } from '../trading/trading.service';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private lastNewsAt = 0;
  private lastSnapshotAt = 0;
  private lastOrderSyncAt = 0;

  constructor(
    private readonly market: MarketService,
    private readonly store: CandleStoreService,
    private readonly news: NewsService,
    private readonly agent: AgentEngine,
    private readonly agentConfig: AgentConfigService,
    private readonly accounts: AccountService,
    private readonly trading: TradingService,
    private readonly registry: ExchangeRegistry,
    private readonly config: ConfigService,
  ) {}

  /** 主循环：模拟行情推进 + Agent 决策节流 + 周期性任务 */
  @Interval(5000)
  async tick() {
    this.market.pumpSimulation();

    const now = Date.now();

    // 新闻抓取
    const newsInterval = Number(this.config.get<string>('NEWS_FETCH_INTERVAL_SEC', '900')) * 1000;
    if (now - this.lastNewsAt > newsInterval) {
      this.lastNewsAt = now;
      void this.news.fetchAll().catch((err) => this.logger.warn(`新闻抓取异常: ${err.message}`));
    }

    // 余额快照（今日盈亏与回撤基线）
    if (now - this.lastSnapshotAt > 60_000) {
      this.lastSnapshotAt = now;
      void this.snapshotBalances();
    }

    // 未终结订单状态同步
    if (now - this.lastOrderSyncAt > 60_000) {
      this.lastOrderSyncAt = now;
      void this.trading.syncOpenOrders();
    }

    await this.runAgentIfDue();
  }

  private async runAgentIfDue() {
    const entity = await this.agentConfig.getOrCreate();
    if (!entity.enabled || this.agent.isRunning) return;

    const intervalMs = Math.max(30, entity.decisionIntervalSec) * 1000;
    const lastRun = entity.lastRunAt ? entity.lastRunAt.getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;

    // 实盘模式下 Agent 不自动携带二次确认 Token，直接跳过并提示
    if (entity.mode === 'live') {
      this.logger.warn('实盘模式不支持自动下单（缺少二次确认），请切换为测试网或模拟撮合');
      return;
    }

    try {
      const summary = await this.agent.runOnce('schedule');
      this.logger.log(`Agent 决策: ${summary.action}（置信度 ${summary.confidence}）`);
    } catch (err) {
      this.logger.error(`Agent 决策失败: ${(err as Error).message}`);
    }
  }

  private async snapshotBalances() {
    try {
      const config = await this.agentConfig.get();
      const { rows, source } = await this.accounts.getBalances(
        config.mode,
        config.enabledExchanges,
      );
      await this.accounts.snapshot(rows, source);
    } catch (err) {
      this.logger.warn(`余额快照失败: ${(err as Error).message}`);
    }
  }

  /** 每小时尝试重新拉取真实行情（此前失败时用于自动恢复） */
  @Cron(CronExpression.EVERY_HOUR)
  async recoverMarket() {
    if (!this.market.isSimulated) return;
    for (const symbol of this.market.getSymbols()) {
      const ok = await this.market.refreshFromExchange(symbol);
      if (ok) this.logger.log(`${symbol} 已恢复为真实行情`);
    }
  }

  /** 每日清理过期新闻 */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneNews() {
    await this.news.prune(30);
    this.logger.log('已清理 30 天前的新闻');
  }

  /** 每 30 分钟探测一次交易所连通性 */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async probeExchanges() {
    for (const code of ['binance', 'okx'] as const) {
      const account = await this.registry.probe(code);
      if (!account.ok) {
        this.logger.debug(`${code} 连通性异常: ${account.message}`);
      }
    }
  }
}
