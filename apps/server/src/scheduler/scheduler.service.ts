import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { EXCHANGE_CODES } from '@ai-trader/shared';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { TradingService } from '../trading/trading.service';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { FuturesEngine } from '../futures/futures-engine.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { FuturesTradingService } from '../futures/futures-trading.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private lastNewsAt = 0;
  private lastOrderSyncAt = 0;
  /** 按 key 记录上次告警时间，避免高频刷屏 */
  private readonly warnThrottle = new Map<string, number>();

  constructor(
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly trading: TradingService,
    private readonly registry: ExchangeRegistry,
    private readonly config: ConfigService,
    private readonly futures: FuturesEngine,
    private readonly futuresConfig: FuturesConfigService,
    private readonly futuresTrading: FuturesTradingService,
  ) {}

  /** 主循环：合约决策节流 + 周期性任务 */
  @Interval(5000)
  async tick() {
    this.market.pumpSimulation();

    const now = Date.now();

    // 新闻抓取（hybrid 链路的 AI 上下文需要）
    const newsInterval = Number(this.config.get<string>('NEWS_FETCH_INTERVAL_SEC', '900')) * 1000;
    if (now - this.lastNewsAt > newsInterval) {
      this.lastNewsAt = now;
      void this.news.fetchAll().catch((err) => this.logger.warn(`新闻抓取异常: ${err.message}`));
    }

    // 未终结订单状态同步 + 合约成交对账（补记成交明细与 Lot，幂等）
    if (now - this.lastOrderSyncAt > 60_000) {
      this.lastOrderSyncAt = now;
      void this.trading.syncOpenOrders();
      void this.futuresTrading
        .syncPendingFills()
        .then((r) => {
          if (r.filled > 0 || r.lots > 0) {
            this.logger.log(
              `合约对账：补记成交 ${r.filled} 笔 / Lot ${r.lots} 个 / 跳过 ${r.skipped} 笔`,
            );
          }
        })
        .catch((err) => this.logger.warn(`合约成交对账异常: ${err.message}`));
    }

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

    // 实盘不自动下单：需人工携带二次确认 Token
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

  /** 按 key 节流输出告警，避免每 5 秒刷屏 */
  private throttledWarn(key: string, message: string, intervalMs: number) {
    const now = Date.now();
    const last = this.warnThrottle.get(key) ?? 0;
    if (now - last < intervalMs) return;
    this.warnThrottle.set(key, now);
    this.logger.warn(message);
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
    for (const code of EXCHANGE_CODES) {
      const account = await this.registry.probe(code);
      if (!account.ok) {
        this.logger.debug(`${code} 连通性异常: ${account.message}`);
      }
    }
  }
}
