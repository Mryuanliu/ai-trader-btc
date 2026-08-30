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
import { RiskService } from '../trading/risk.service';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { FuturesEngine } from '../futures/futures-engine.service';
import { FuturesConfigService } from '../futures/futures-config.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private lastNewsAt = 0;
  private lastSnapshotAt = 0;
  private lastOrderSyncAt = 0;
  private lastLiveSkipEventAt = 0;
  /** 按 key 记录上次告警时间，避免高频刷屏 */
  private readonly warnThrottle = new Map<string, number>();

  constructor(
    private readonly market: MarketService,
    private readonly store: CandleStoreService,
    private readonly news: NewsService,
    private readonly agent: AgentEngine,
    private readonly agentConfig: AgentConfigService,
    private readonly accounts: AccountService,
    private readonly trading: TradingService,
    private readonly risk: RiskService,
    private readonly registry: ExchangeRegistry,
    private readonly config: ConfigService,
    private readonly futures: FuturesEngine,
    private readonly futuresConfig: FuturesConfigService,
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
    await this.runFuturesIfDue();
  }

  /**
   * 合约链路调度：与现货**彼此独立**。
   *
   * 独立开关、独立配置、独立熔断计数器——关闭合约不影响现货，
   * 合约连续失败进入熔断也不会牵连现货链路。
   */
  private async runFuturesIfDue() {
    const entity = await this.futuresConfig.getEntity();
    if (!entity.enabled || this.futures.isRunning) return;

    const intervalMs = Math.max(30, entity.decisionIntervalSec) * 1000;
    const lastRun = entity.lastRunAt ? entity.lastRunAt.getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;

    const gate = this.futures.shouldSkipScheduledRun();
    if (gate.skip) {
      this.throttledWarn('futures-backoff', gate.reason ?? '合约处于冷却期', 10 * 60_000);
      return;
    }

    // 实盘同样不自动下单（与现货一致：需人工携带二次确认 Token）
    if (entity.mode === 'live') {
      this.throttledWarn(
        'futures-live-skipped',
        '合约实盘模式不支持自动下单：需通过前端手动下单并携带确认 Token',
        10 * 60_000,
      );
      return;
    }

    try {
      const summary = await this.futures.runOnce('schedule');
      this.logger.log(`合约决策: ${summary.action}（置信度 ${summary.confidence}）`);
    } catch (err) {
      this.logger.error(`合约决策失败: ${(err as Error).message}`);
    }
  }

  private async runAgentIfDue() {
    const entity = await this.agentConfig.getOrCreate();
    if (!entity.enabled || this.agent.isRunning) return;

    const intervalMs = Math.max(30, entity.decisionIntervalSec) * 1000;
    const lastRun = entity.lastRunAt ? entity.lastRunAt.getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;

    // 连续失败后按退避/熔断跳过，避免每 5 秒重试打爆 LLM 与交易所
    const gate = this.agent.shouldSkipScheduledRun();
    if (gate.skip) {
      this.throttledWarn('agent-backoff', gate.reason ?? '处于冷却期', 10 * 60_000);
      return;
    }

    // 实盘不自动下单（设计如此：需人工携带二次确认 Token）。
    // 这里补写一条风控事件并节流告警，避免「以为在跑其实没跑」且无痕迹。
    if (entity.mode === 'live') {
      await this.recordLiveSkipped(entity.symbol);
      return;
    }

    try {
      const summary = await this.agent.runOnce('schedule');
      this.logger.log(`Agent 决策: ${summary.action}（置信度 ${summary.confidence}）`);
    } catch (err) {
      this.logger.error(`Agent 决策失败: ${(err as Error).message}`);
    }
  }

  /**
   * 实盘跳过时落一条可审计的事件。
   * 日志每 10 分钟才打一次，但事件按每小时写入一次，保证前端风控面板能看到。
   */
  private async recordLiveSkipped(symbol: string) {
    const note =
      '实盘模式不支持自动下单：Agent 不会自动携带二次确认 Token。' +
      '如需实盘交易，请通过前端手动下单（携带确认 Token），或切换为 testnet / dry_run。';

    this.throttledWarn('live-skipped', note, 10 * 60_000);

    const now = Date.now();
    if (now - this.lastLiveSkipEventAt < 60 * 60_000) return;
    this.lastLiveSkipEventAt = now;
    try {
      await this.risk.record('reject', 'warn', note, symbol, null);
    } catch (err) {
      this.logger.warn(`记录实盘跳过事件失败: ${(err as Error).message}`);
    }
  }

  /** 按 key 节流输出告警，避免每 5 秒刷屏 */
  private throttledWarn(key: string, message: string, intervalMs: number) {
    const now = Date.now();
    const last = this.warnThrottle.get(key) ?? 0;
    if (now - last < intervalMs) return;
    this.warnThrottle.set(key, now);
    this.logger.warn(message);
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
