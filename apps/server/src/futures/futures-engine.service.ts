import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Candle,
  DecisionInputSnapshot,
  DecisionSummary,
  FuturesAgentConfigShape,
  PositionSnapshot,
  evaluateExitRules,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { DecisionCoreService, LaneDecision } from '../agent/decision-core.service';
import { FuturesConfigService } from './futures-config.service';
import { FuturesPositionService } from './futures-position.service';
import { FuturesRiskService } from './futures-risk.service';
import { FuturesTradingService } from './futures-trading.service';
import { NewsService } from '../news/news.service';
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.adapter';
import { ExchangeRegistry } from '../exchanges/exchange-registry.service';
import { EventBusService } from '../common/events';

const HISTORY_LIMIT = 200;

/** 连续失败达到该次数后熔断（与现货引擎同参数，但计数器彼此独立） */
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

/**
 * 合约决策引擎（独立链路）。
 *
 * 与现货 AgentEngine 的关系：
 * - **L0~L3 完全共用**：指标、信号、策略插件、链路分派都走 DecisionCoreService，
 *   合约因此可以直接选用现货的策略体系（trend_following / mean_reversion / breakout）。
 * - **L4~L6 各自独立**：执行走 FuturesTradingService，持仓以交易所 positionRisk 为权威，
 *   风控用合约专属口径（杠杆/保证金/强平距离）。
 * - **开关与熔断彼此独立**：关闭或熔断合约都不影响现货，反之亦然。
 */
@Injectable()
export class FuturesEngine {
  private readonly logger = new Logger(FuturesEngine.name);
  private running = false;

  /** 连续失败次数，成功后清零（与现货引擎各自独立计数） */
  private consecutiveFailures = 0;
  /** 在下次该时间点之前，调度器应跳过本次自动运行 */
  private nextRetryAt = 0;
  private lastDecisionId: string | null = null;

  constructor(
    @InjectRepository(AgentDecisionEntity)
    private readonly decisionRepo: Repository<AgentDecisionEntity>,
    private readonly futuresConfig: FuturesConfigService,
    private readonly core: DecisionCoreService,
    private readonly positions: FuturesPositionService,
    private readonly trading: FuturesTradingService,
    private readonly risk: FuturesRiskService,
    private readonly news: NewsService,
    private readonly registry: ExchangeRegistry,
    private readonly events: EventBusService,
    private readonly config: ConfigService,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  getHealth(): { consecutiveFailures: number; nextRetryAt: number; tripped: boolean } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      tripped: this.isTripped(),
    };
  }

  private isTripped(): boolean {
    return this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && Date.now() < this.nextRetryAt;
  }

  /** 调度器在自动触发前应调用此方法判断是否该跳过 */
  shouldSkipScheduledRun(): { skip: boolean; reason?: string } {
    if (this.isTripped()) {
      return {
        skip: true,
        reason:
          `合约已连续失败 ${this.consecutiveFailures} 次，熔断至 ` +
          `${new Date(this.nextRetryAt).toLocaleString('zh-CN')}`,
      };
    }
    if (Date.now() < this.nextRetryAt) {
      return { skip: true, reason: '合约处于失败退避冷却期' };
    }
    return { skip: false };
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.log(`合约链路恢复正常，连续失败计数已清零（此前 ${this.consecutiveFailures} 次）`);
    }
    this.consecutiveFailures = 0;
    this.nextRetryAt = 0;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    const n = this.consecutiveFailures;
    const backoff =
      n >= CIRCUIT_BREAKER_THRESHOLD
        ? CIRCUIT_BREAKER_COOLDOWN_MS
        : Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (n - 1), RETRY_BACKOFF_MAX_MS);
    this.nextRetryAt = Date.now() + backoff;

    this.logger.warn(
      `合约第 ${n} 次连续失败（下次尝试 ${Math.round(backoff / 1000)}s 后）: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );
    if (n >= CIRCUIT_BREAKER_THRESHOLD) {
      this.logger.error(`合约连续失败达到 ${CIRCUIT_BREAKER_THRESHOLD} 次，已熔断 10 分钟`);
    }
  }

  /** 执行一次完整决策；同一时刻只允许一个决策在运行 */
  async runOnce(trigger: 'schedule' | 'manual' = 'schedule'): Promise<DecisionSummary> {
    if (this.running) {
      throw new Error('合约引擎正在决策中，请稍后重试');
    }
    this.running = true;
    const startedAt = Date.now();

    try {
      const cfg = await this.futuresConfig.get();
      const snapshot = await this.buildSnapshot(cfg);

      // 出场规则优先级最高（方向感知）；其次才是策略/AI 决策
      const exitResult = await this.checkExitRules(cfg, snapshot);
      const laneResult = exitResult ?? (await this.produceDecision(cfg, snapshot));
      const decision = laneResult.decision;

      this.logger.log(
        `合约决策完成: ${cfg.symbol} ${decision.action} 置信度 ${decision.confidence}` +
          `（链路 ${laneResult.lane}${laneResult.degraded ? '，已降级' : ''}）`,
      );

      // 先落库决策，再把下单结果回填，保证 order 与 decision 双向可追溯
      let entity = await this.decisionRepo.save(
        this.decisionRepo.create({
          agentId: 'futures-default',
          market: 'futures',
          symbol: cfg.symbol,
          action: decision.action,
          confidence: decision.confidence,
          // 与现货同口径：接近度 + 结构化归因，让合约的每条 HOLD 也可解释
          proximity: decision.proximity ?? null,
          reason: decision.reason,
          riskNotes: decision.riskNotes ?? null,
          blockingReason: decision.diagnostics?.code ?? null,
          diagnostics: decision.diagnostics ?? null,
          inputSnapshot: snapshot,
          prompt: laneResult.prompt,
          llmRaw: laneResult.llmResult?.raw ?? null,
          llmReasoning: laneResult.llmResult?.reasoning ?? null,
          llmModel: laneResult.llmResult?.model ?? null,
          llmUsage: laneResult.llmResult?.usage
            ? {
                prompt: laneResult.llmResult.usage.promptTokens,
                completion: laneResult.llmResult.usage.completionTokens,
                total: laneResult.llmResult.usage.totalTokens,
              }
            : null,
          lane: laneResult.lane,
          strategyName: laneResult.strategyName,
          degraded: laneResult.degraded,
          degradeReason: laneResult.degradeReason,
          riskPassed: true,
          orderId: null,
          latencyMs: 0,
        }),
      );
      this.lastDecisionId = entity.id;

      const result = await this.execute(cfg, decision, entity.id);
      entity.riskPassed = result.risk?.passed ?? true;
      entity.riskRejectedBy = result.risk?.rejectedBy ?? null;
      entity.riskNote = result.risk?.note ?? null;
      entity.orderId = result.orderId;
      entity.latencyMs = Date.now() - startedAt;
      entity = await this.decisionRepo.save(entity);

      const summary = this.toSummary(entity);
      this.events.emit('decision', summary);
      this.recordSuccess();
      return summary;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    } finally {
      this.running = false;
      try {
        await this.futuresConfig.markRun(this.lastDecisionId);
      } catch (err) {
        this.logger.warn(`更新合约最后运行时间失败: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 构造决策输入快照。
   *
   * 与现货的差异：K线与行情取**合约自身**数据源（与现货存在基差），
   * 账户口径是「可用保证金 / 净持仓」而非「USDT/BTC 余额」。
   */
  private async buildSnapshot(cfg: FuturesAgentConfigShape): Promise<DecisionInputSnapshot> {
    const adapter = await this.adapter();
    const candles = await adapter.getKlines({
      symbol: cfg.symbol,
      interval: cfg.timeframe,
      limit: HISTORY_LIMIT,
    });
    if (candles.length === 0) {
      throw new Error('暂无可用合约 K 线数据');
    }

    const ticker = await adapter.getTicker(cfg.symbol);
    const recentNews = await this.news.getRecent(6);
    const margin = await this.trading.getAvailableMargin();
    const currentQty = await this.positions.getNetQuantity(cfg.symbol);

    return this.core.buildSnapshot({
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      candles,
      ticker,
      // 按策略语义构造信号（B3）：与现货同口径
      strategyName: cfg.strategyName,
      news: recentNews.map((n) => ({
        title: n.title,
        source: n.source,
        publishedAt: n.publishedAt,
      })),
      account: {
        // 合约账户语义映射：quoteFree=可用保证金，baseFree=当前净持仓绝对值
        quoteFree: margin,
        baseFree: Math.abs(currentQty),
        mode: cfg.mode,
        environment: cfg.mode === 'live' ? 'live' : 'testnet',
        source: 'exchange',
      },
    });
  }

  /** 委托共享决策内核产出决策（指标/信号/策略插件与现货完全一致） */
  private async produceDecision(
    cfg: FuturesAgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision> {
    const position = await this.toPositionSnapshot(cfg.symbol);
    return this.core.produceDecision(
      {
        decisionLane: cfg.decisionLane,
        strategyName: cfg.strategyName,
        strategyParams: cfg.strategyParams,
        // 合约专属 systemPrompt：强调杠杆风险（AI 只输出上下文元参数，不输出买卖指令）
        systemPrompt: DEFAULT_FUTURES_PROMPT,
        model: this.config.get<string>('LLM_MODEL', 'deepseek-chat'),
        temperature: Number(this.config.get<string>('LLM_TEMPERATURE', '0.2')),
        maxTokens: Number(this.config.get<string>('LLM_MAX_TOKENS', '800')),
        // 独立的 AI 上下文缓存：不复用现货的，保证合约决策有自己的 LLM 调用留痕
        insightCacheKey: 'futures',
      },
      snapshot,
      position,
    );
  }

  /**
   * 合约出场规则（方向感知）。
   *
   * 与现货的唯一差异：空头持仓的盈亏随价格反向变动，
   * 且平仓动作是 BUY 而不是 SELL。判定本身共用同一个纯函数。
   */
  private async checkExitRules(
    cfg: FuturesAgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision | null> {
    const { stopLossPct, takeProfitPct } = cfg.exitRules ?? {};
    if (stopLossPct == null && takeProfitPct == null) return null;

    const position = await this.positions.toView(cfg.symbol);
    if (!position || Math.abs(position.quantity) <= 0 || !(position.entryPrice > 0)) return null;

    const price = snapshot.ticker.price || snapshot.indicators.lastClose;
    if (!(price > 0)) return null;

    const exit = evaluateExitRules({
      entryPrice: position.entryPrice,
      price,
      side: position.positionSide,
      exitRules: cfg.exitRules,
    });
    if (!exit.triggered || !exit.closeAction) return null;

    this.logger.warn(`合约出场规则触发 → 全平：${exit.reason}`);
    return {
      lane: 'strategy',
      strategyName: null,
      degraded: true,
      degradeReason: `合约出场规则触发（优先级高于开仓信号）：${exit.reason}`,
      llmResult: null,
      prompt: '',
      closeAll: true,
      decision: {
        action: exit.closeAction,
        confidence: 1,
        reason: `合约出场规则触发：${exit.reason}。按出场规则全部平仓。`,
        riskNotes: '出场规则属于持仓层能力，优先级高于开仓信号，平仓动作按持仓方向取反。',
      },
    };
  }

  /**
   * 执行下单。
   *
   * 与现货的关键差异：本引擎不做数量计算与预检——
   * 保证金推导、杠杆钳制、强平距离校验都在 FuturesTradingService 内按合约口径完成。
   */
  private async execute(
    cfg: FuturesAgentConfigShape,
    decision: { action: 'BUY' | 'SELL' | 'HOLD'; confidence: number },
    decisionId: string,
  ): Promise<{ orderId: string | null; risk?: { passed: boolean; rejectedBy?: string; note?: string } }> {
    if (decision.action === 'HOLD') {
      return { orderId: null, risk: { passed: true, note: '观望，无需下单' } };
    }
    if (decision.confidence < cfg.minConfidence) {
      const note = `置信度 ${decision.confidence} 低于阈值 ${cfg.minConfidence}，不执行下单`;
      await this.risk.record('confidence', 'info', note, cfg.symbol, decisionId);
      return { orderId: null, risk: { passed: false, rejectedBy: 'MIN_CONFIDENCE', note } };
    }

    try {
      const result = await this.trading.placeOrder({
        symbol: cfg.symbol,
        action: decision.action,
        type: 'MARKET',
        source: 'agent',
        decisionId,
      });
      return { orderId: result.order?.id ?? null, risk: result.risk };
    } catch (err) {
      // 风控拦截属于正常业务分支，不应触发熔断退避
      const message = (err as Error).message;
      await this.risk.record('reject', 'warn', `合约下单未执行：${message}`, cfg.symbol, decisionId);
      throw err;
    }
  }

  /**
   * 把合约持仓映射为策略层需要的 PositionSnapshot。
   *
   * 净持仓取绝对值：策略只关心「仓位有多大」，方向由执行层的
   * resolveFuturesOrderIntent 结合净持仓的正负决定，策略层无需感知多空。
   */
  private async toPositionSnapshot(symbol: string): Promise<PositionSnapshot> {
    const view = await this.positions.toView(symbol);
    const qty = view?.quantity ?? 0;
    return {
      symbol,
      quantity: Math.abs(qty),
      avgCost: view?.entryPrice ?? 0,
      realizedPnl: 0,
      unrealizedPnl: view?.unrealizedPnl ?? 0,
      marketValue: view?.notional ?? 0,
      totalBought: qty > 0 ? Math.abs(qty) : 0,
      totalSold: qty < 0 ? Math.abs(qty) : 0,
      totalFee: 0,
    };
  }

  private async adapter(): Promise<BinanceFuturesAdapter> {
    const adapter = await this.registry.get('binance-futures');
    if (!(adapter instanceof BinanceFuturesAdapter)) {
      throw new Error('binance-futures 适配器类型不符');
    }
    return adapter;
  }

  toSummary(entity: AgentDecisionEntity): DecisionSummary {
    return {
      id: entity.id,
      symbol: entity.symbol,
      action: entity.action,
      confidence: entity.confidence,
      reason: entity.reason,
      lane: entity.lane === 'hybrid' ? 'hybrid' : 'strategy',
      strategyName: entity.strategyName ?? null,
      degraded: entity.degraded,
      degradeReason: entity.degradeReason ?? null,
      riskPassed: entity.riskPassed,
      riskRejectedBy: entity.riskRejectedBy,
      latencyMs: entity.latencyMs,
      createdAt: entity.createdAt.toISOString(),
      llmModel: entity.llmModel ?? null,
      llmReasoning: entity.llmReasoning ?? null,
      llmUsage: entity.llmUsage ?? null,
    };
  }

  /** 合约决策列表（按 market 隔离） */
  async list(params: { limit?: number } = {}): Promise<DecisionSummary[]> {
    const rows = await this.decisionRepo.find({
      where: { market: 'futures' },
      order: { createdAt: 'DESC' },
      take: Math.min(100, Math.max(1, params.limit ?? 20)),
    });
    return rows.map((r) => this.toSummary(r));
  }

  async detail(id: string): Promise<AgentDecisionEntity | null> {
    return this.decisionRepo.findOne({ where: { id } });
  }
}

const DEFAULT_FUTURES_PROMPT = [
  '你是一名纪律严明的比特币合约量化交易员。',
  '你会收到技术指标信号、K 线摘要、账户保证金状态与近期新闻，必须输出严格的市场上下文判断。',
  '你只输出对市场状态的判断（趋势、激进度、情绪），不输出具体买卖指令。',
  '合约带杠杆，风险高于现货：行情矛盾或波动剧烈时，务必倾向保守。',
].join('\n');
