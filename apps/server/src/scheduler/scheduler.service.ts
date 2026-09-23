import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { EXCHANGE_CODES } from '@ai-trader/shared';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { StrategyRunner } from '../strategy/strategy-runner.service';

/**
 * 主循环。
 *
 * 与改造前的区别：**不再做任何决策调度**（原 FuturesEngine 的
 * `shouldSkipScheduledRun` / 冷却 / 熔断 / 实盘拦截都已移除）。
 * 这里只做三件事：喂行情、对账订单、驱动已挂载的策略。
 * 策略是否该下单、下多少，全由策略自己决定。
 */
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
    private readonly registry: ExchangeRegistry,
    private readonly config: ConfigService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly futuresTrading: FuturesTradingService,
    private readonly strategy: StrategyRunner,
  ) {}

  /** 主循环：行情、对账、挂单触发、策略驱动 */
  @Interval(5000)
  async tick() {
    this.market.pumpSimulation();

    const now = Date.now();

    // 新闻抓取（「AI 行情分析」的上下文来源）
    const newsInterval = Number(this.config.get<string>('NEWS_FETCH_INTERVAL_SEC', '900')) * 1000;
    if (now - this.lastNewsAt > newsInterval) {
      this.lastNewsAt = now;
      void this.news.fetchAll().catch((err) => this.logger.warn(`新闻抓取异常: ${err.message}`));
    }

    // 合约成交对账（补记成交明细与 Lot，幂等）。
    // 订单状态推进已包含在 syncPendingFills 里（它会回查交易所并更新状态），
    // 原先额外的 TradingService.syncOpenOrders 对合约单是重复劳动，已移除。
    if (now - this.lastOrderSyncAt > 60_000) {
      this.lastOrderSyncAt = now;
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

    // dry-run 的网格挂单需要每 tick 检查触发（否则要等一个对账周期才成交）
    await this.triggerDryRunOrders();

    // 驱动已挂载的策略（无策略时是空操作）
    await this.strategy.tick();
  }

  /** dry-run 模式：按当前行情模拟触发网格挂单（真实模式由交易所触发） */
  private async triggerDryRunOrders() {
    try {
      const cfg = await this.futuresConfig.get();
      if (cfg.mode !== 'dry_run') return;
      const result = await this.futuresTrading.processDryRunGridOrders(cfg.symbol);
      if (result.triggered > 0) {
        this.logger.log(`dry-run 网格挂单触发 ${result.triggered} 笔`);
      }
    } catch (err) {
      this.throttledWarn('dry-run-trigger', `dry-run 挂单触发检查异常: ${(err as Error).message}`, 60_000);
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
