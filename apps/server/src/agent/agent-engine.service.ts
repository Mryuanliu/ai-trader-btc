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

@Injectable()
export class AgentEngine {
  private readonly logger = new Logger(AgentEngine.name);
  private running = false;

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

      const orderId = await this.execute(config, snapshot, decision, entity.id);
      const riskVerdict = this.lastRiskVerdict;

      entity.riskPassed = riskVerdict?.passed ?? true;
      entity.riskRejectedBy = riskVerdict?.rejectedBy ?? null;
      entity.riskNote = riskVerdict?.note ?? null;
      entity.orderId = orderId;
      entity.latencyMs = Date.now() - startedAt;
      entity = await this.decisionRepo.save(entity);

      await this.news.markCited(snapshot.news.map((n) => n.title));
      await this.agentConfig.markRun(entity.id);

      const summary = this.toSummary(entity);
      this.events.emit('decision', summary);
      return summary;
    } finally {
      this.running = false;
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
    const verdict = await this.risk.check({
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
    this.lastRiskVerdict = verdict;

    if (!verdict.passed) {
      await this.risk.record(
        'reject',
        'warn',
        `Agent 决策被风控拦截：${verdict.note}`,
        config.symbol,
        decisionId,
      );
      return null;
    }

    const order = await this.trading.placeOrder({
      symbol: config.symbol,
      side,
      type: 'MARKET',
      quantity,
      source: 'agent',
      decisionId,
      // 风控已在上面独立执行，避免重复累计今日笔数
      skipRisk: true,
    });
    return order.id;
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
