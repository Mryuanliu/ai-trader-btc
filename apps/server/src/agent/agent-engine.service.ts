import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentConfigShape,
  Candle,
  DecisionAction,
  DecisionInputSnapshot,
  DecisionSummary,
  buildSignals,
  computeIndicators,
  scoreSignals,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { AgentConfigService } from './agent-config.service';
import { LlmClient, LlmDecision } from './llm.client';
import { buildUserPrompt } from './prompt';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { AccountService } from '../account/account.service';
import { TradingService } from '../trading/trading.service';
import { RiskService } from '../trading/risk.service';
import { EventBusService } from '../common/events';

const HISTORY_LIMIT = 200;

/** 连续失败达到该次数后熔断，停止自动调度直到冷却期结束 */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** 熔断后的冷却时长：留足时间让下游（LLM / 交易所）恢复 */
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
/** 连续失败退避基数，实际退避 = min(base * 2^(n-1), max) */
const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

@Injectable()
export class AgentEngine {
  private readonly logger = new Logger(AgentEngine.name);
  private running = false;

  /** 连续失败次数，成功后清零 */
  private consecutiveFailures = 0;
  /** 在下次该时间点之前，调度器应跳过本次自动运行 */
  private nextRetryAt = 0;
  /** 最近一次决策 ID，供 finally 中推进 lastRunAt 使用 */
  private lastDecisionId: string | null = null;

  constructor(
    @InjectRepository(AgentDecisionEntity)
    private readonly decisionRepo: Repository<AgentDecisionEntity>,
    private readonly agentConfig: AgentConfigService,
    private readonly llm: LlmClient,
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly accounts: AccountService,
    private readonly trading: TradingService,
    private readonly risk: RiskService,
    private readonly events: EventBusService,
    private readonly config: ConfigService,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** 供健康检查与前端展示的熔断状态 */
  getHealth(): { consecutiveFailures: number; nextRetryAt: number; tripped: boolean } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      tripped: this.isTripped(),
    };
  }

  /** 是否处于熔断冷却期 */
  private isTripped(): boolean {
    return this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && Date.now() < this.nextRetryAt;
  }

  /**
   * 调度器在自动触发前应调用此方法判断是否该跳过。
   * 手动触发不受限制，便于熔断期间人工介入排查。
   */
  shouldSkipScheduledRun(): { skip: boolean; reason?: string } {
    if (this.isTripped()) {
      return {
        skip: true,
        reason:
          `已连续失败 ${this.consecutiveFailures} 次，熔断至 ` +
          `${new Date(this.nextRetryAt).toLocaleString('zh-CN')}`,
      };
    }
    if (Date.now() < this.nextRetryAt) {
      return { skip: true, reason: '处于失败退避冷却期' };
    }
    return { skip: false };
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.log(`Agent 恢复正常，连续失败计数已清零（此前 ${this.consecutiveFailures} 次）`);
    }
    this.consecutiveFailures = 0;
    this.nextRetryAt = 0;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    const n = this.consecutiveFailures;

    // 达到阈值进入长冷却（熔断），未达到则指数退避，避免每 5 秒重试打爆下游
    const backoff =
      n >= CIRCUIT_BREAKER_THRESHOLD
        ? CIRCUIT_BREAKER_COOLDOWN_MS
        : Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (n - 1), RETRY_BACKOFF_MAX_MS);
    this.nextRetryAt = Date.now() + backoff;

    this.logger.warn(
      `Agent 第 ${n} 次连续失败（下次尝试 ${Math.round(backoff / 1000)}s 后）: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );

    if (n >= CIRCUIT_BREAKER_THRESHOLD) {
      this.logger.error(
        `连续失败达到 ${CIRCUIT_BREAKER_THRESHOLD} 次，已熔断 ` +
          `${CIRCUIT_BREAKER_COOLDOWN_MS / 60000} 分钟，请排查 LLM 或交易所连通性`,
      );
    }
  }

  /** 执行一次完整决策；同一时刻只允许一个决策在运行 */
  async runOnce(trigger: 'schedule' | 'manual' = 'schedule'): Promise<DecisionSummary> {
    if (this.running) {
      throw new Error('Agent 正在决策中，请稍后重试');
    }
    this.running = true;
    const startedAt = Date.now();

    try {
      const config = await this.agentConfig.get();
      const candles = this.market.getCandles(config.symbol, config.timeframe, HISTORY_LIMIT);
      if (candles.length === 0) {
        throw new Error('暂无可用 K 线数据');
      }

      const snapshot = await this.buildSnapshot(config, candles);
      const prompt = buildUserPrompt(snapshot);

      const llmResult = await this.llm.decide(
        config.systemPrompt,
        prompt,
        config.model,
        config.temperature,
        config.maxTokens,
      );

      let decision: LlmDecision;
      let degraded = false;
      let degradeReason: string | null = null;

      if (llmResult.ok && llmResult.data) {
        decision = llmResult.data;
      } else {
        degraded = true;
        degradeReason = llmResult.error ?? '模型不可用';
        decision = this.fallbackDecision(snapshot);

        // 降级态下兜底的纯指标策略未经回测验证，默认不允许它接管真实资金。
        // 配置为 signal 时才保留原有行为，供有充分评估的场景使用。
        if (config.degradedAction === 'hold' && decision.action !== 'HOLD') {
          this.logger.warn(
            `LLM 不可用且降级动作为 hold，已将 ${decision.action} 降级为 HOLD（降级原因：${degradeReason}）`,
          );
          decision = {
            ...decision,
            action: 'HOLD',
            reason:
              `${decision.reason}\n\n【降级保护】模型不可用（${degradeReason}），` +
              `按配置 degradedAction=hold 强制观望，避免未经验证的兜底策略接管资金。`,
            riskNotes: '降级态强制观望，未执行下单。',
          };
        }
      }

      this.logger.log(
        `决策完成: ${config.symbol} ${decision.action} 置信度 ${decision.confidence}` +
          `${degraded ? '（已降级为纯指标）' : ''} 耗时 ${Date.now() - startedAt}ms`,
      );

      // 先落库决策，再把下单结果回填，保证 order 与 decision 双向可追溯
      let entity = await this.decisionRepo.save(
        this.decisionRepo.create({
          agentId: 'default',
          symbol: config.symbol,
          action: decision.action,
          confidence: decision.confidence,
          reason: decision.reason,
          riskNotes: decision.riskNotes ?? null,
          inputSnapshot: snapshot,
          prompt,
          llmRaw: llmResult.raw,
          llmReasoning: llmResult.reasoning ?? null,
          llmModel: llmResult.model ?? null,
          llmUsage: llmResult.usage
            ? {
                prompt: llmResult.usage.promptTokens,
                completion: llmResult.usage.completionTokens,
                total: llmResult.usage.totalTokens,
              }
            : null,
          degraded,
          degradeReason,
          riskPassed: true,
          orderId: null,
          latencyMs: 0,
        }),
      );
      this.lastDecisionId = entity.id;

      const orderId = await this.execute(config, snapshot, decision, entity.id);
      const riskVerdict = this.lastRiskVerdict;

      entity.riskPassed = riskVerdict?.passed ?? true;
      entity.riskRejectedBy = riskVerdict?.rejectedBy ?? null;
      entity.riskNote = riskVerdict?.note ?? null;
      entity.orderId = orderId;
      entity.latencyMs = Date.now() - startedAt;
      entity = await this.decisionRepo.save(entity);

      await this.news.markCited(snapshot.news.map((n) => n.title));

      const summary = this.toSummary(entity);
      this.events.emit('decision', summary);
      this.recordSuccess();
      return summary;
    } catch (err) {
      // 失败同样要推进 lastRunAt，否则调度器会判定为到期而每 5 秒重试一次。
      // 退避与熔断由 nextRetryAt 控制，与 lastRunAt 解耦。
      this.recordFailure(err);
      throw err;
    } finally {
      this.running = false;
      try {
        await this.agentConfig.markRun(this.lastDecisionId);
      } catch (err) {
        this.logger.warn(`更新最后运行时间失败: ${(err as Error).message}`);
      }
    }
  }

  private lastRiskVerdict: { passed: boolean; rejectedBy?: string; note?: string } | null = null;

  private async buildSnapshot(
    config: AgentConfigShape,
    candles: Candle[],
  ): Promise<DecisionInputSnapshot> {
    const indicators = computeIndicators(candles);
    const signals = buildSignals(indicators, candles);
    const indicatorScore = scoreSignals(signals);
    const ticker = this.market.getTicker(config.symbol);
    const recentNews = await this.news.getRecent(6);
    const balances = await this.accounts.getBalances(config.mode, config.enabledExchanges);
    const balanceSource = balances.source;

    const quoteFree = balances.rows
      .filter((r) => r.asset === 'USDT')
      .reduce((acc, r) => acc + r.free, 0);
    const baseFree = balances.rows
      .filter((r) => r.asset === 'BTC')
      .reduce((acc, r) => acc + r.free, 0);

    return {
      symbol: config.symbol,
      timeframe: config.timeframe,
      ticker,
      candles,
      indicators,
      signals,
      indicatorScore,
      news: recentNews.map((n) => ({
        title: n.title,
        source: n.source,
        publishedAt: n.publishedAt,
      })),
      account: {
        quoteFree,
        baseFree,
        mode: config.mode,
        environment: config.mode === 'live' ? 'live' : 'testnet',
        source: balanceSource,
      },
    };
  }

  /** 模型不可用时的纯指标策略 */
  private fallbackDecision(snapshot: DecisionInputSnapshot): LlmDecision {
    const score = snapshot.indicatorScore;
    const magnitude = Math.min(1, Math.abs(score));
    let action: DecisionAction = 'HOLD';
    if (score >= 0.25) action = 'BUY';
    else if (score <= -0.25) action = 'SELL';

    const direction = score > 0 ? '偏多' : score < 0 ? '偏空' : '中性';
    return {
      action,
      confidence: Number((0.45 + magnitude * 0.4).toFixed(2)),
      reason: `模型不可用，按指标信号执行：综合倾向 ${score.toFixed(2)}（${direction}），采用 MA/RSI/MACD/布林带加权结果。`,
      riskNotes: '当前为降级决策，未经过语义层面的新闻解读，建议降低仓位。',
    };
  }

  /** 风控校验 + 下单 */
  private async execute(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
    decision: LlmDecision,
    decisionId: string,
  ): Promise<string | null> {
    this.lastRiskVerdict = null;

    if (decision.action === 'HOLD') {
      this.lastRiskVerdict = { passed: true, note: '观望，无需下单' };
      return null;
    }
    if (decision.confidence < config.minConfidence) {
      this.lastRiskVerdict = {
        passed: false,
        rejectedBy: 'MIN_CONFIDENCE',
        note: `置信度 ${decision.confidence} 低于阈值 ${config.minConfidence}，不执行下单`,
      };
      await this.risk.record(
        'confidence',
        'info',
        `决策置信度不足，未下单：${decision.reason}`,
        config.symbol,
        decisionId,
      );
      return null;
    }

    const price = snapshot.ticker.price || snapshot.indicators.lastClose;
    if (!(price > 0)) {
      this.lastRiskVerdict = { passed: false, rejectedBy: 'NO_PRICE', note: '无法获取有效价格' };
      return null;
    }

    const side = decision.action === 'BUY' ? 'BUY' : 'SELL';
    const quantity =
      side === 'BUY'
        ? ((snapshot.account.quoteFree * config.positionPct) / price)
        : snapshot.account.baseFree * config.positionPct;

    if (!(quantity > 0)) {
      this.lastRiskVerdict = {
        passed: false,
        rejectedBy: 'INSUFFICIENT_BALANCE',
        note: '按仓位比例计算出的下单数量为 0，可用余额不足',
      };
      return null;
    }

    const quoteAmount = price * quantity;
    // 咨询性预检：用于快速失败并把拦截原因写入决策记录。
    // 这里不做取整，因此金额是估算值；真正的权威校验在 TradingService 内
    // 基于「取整后数量 + 最终成交价」执行，两者不一致时以那边为准。
    const preCheck = await this.risk.check({
      config,
      symbol: config.symbol,
      side,
      quantity,
      price,
      quoteAmount,
      quoteFree: snapshot.account.quoteFree,
      baseFree: snapshot.account.baseFree,
      quoteSource: snapshot.account.source,
      source: 'agent',
      liveConfirmToken: this.config.get<string>('LIVE_TRADING_CONFIRM_TOKEN', ''),
    });

    if (!preCheck.passed) {
      this.lastRiskVerdict = preCheck;
      await this.risk.record(
        'reject',
        'warn',
        `Agent 决策被风控拦截：${preCheck.note}`,
        config.symbol,
        decisionId,
      );
      return null;
    }

    const result = await this.trading.placeOrder({
      symbol: config.symbol,
      side,
      type: 'MARKET',
      quantity,
      source: 'agent',
      decisionId,
    });
    // 以权威结论覆盖预检结果，保证决策记录与真实执行的判定一致
    this.lastRiskVerdict = result.risk;
    return result.order.id;
  }

  toSummary(entity: AgentDecisionEntity): DecisionSummary {
    return {
      id: entity.id,
      symbol: entity.symbol,
      action: entity.action,
      confidence: entity.confidence,
      reason: entity.reason,
      degraded: entity.degraded,
      riskPassed: entity.riskPassed,
      riskRejectedBy: entity.riskRejectedBy,
      latencyMs: entity.latencyMs,
      createdAt: entity.createdAt.toISOString(),
      llmModel: entity.llmModel ?? null,
      llmReasoning: entity.llmReasoning ?? null,
      llmUsage: entity.llmUsage ?? null,
    };
  }

  async list(params: {
    page?: number;
    pageSize?: number;
    action?: DecisionAction;
    executedOnly?: boolean;
    keyword?: string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));

    const qb = this.decisionRepo.createQueryBuilder('d');
    if (params.action) qb.andWhere('d.action = :action', { action: params.action });
    if (params.executedOnly) qb.andWhere('d.orderId IS NOT NULL');
    if (params.keyword) {
      qb.andWhere('(d.reason ILIKE :kw OR d.riskNotes ILIKE :kw)', { kw: `%${params.keyword}%` });
    }
    qb.orderBy('d.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);

    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.toSummary(r)), total, page, pageSize };
  }

  async recent(limit = 10): Promise<DecisionSummary[]> {
    const rows = await this.decisionRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map((r) => this.toSummary(r));
  }

  async detail(id: string): Promise<AgentDecisionEntity | null> {
    return this.decisionRepo.findOne({ where: { id } });
  }
}
