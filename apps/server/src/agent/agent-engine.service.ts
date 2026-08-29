import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentConfigShape,
  Candle,
  DecisionAction,
  DecisionInputSnapshot,
  DecisionLane,
  DecisionSummary,
  ContextInsight,
  NEUTRAL_CONTEXT_INSIGHT,
  StrategyContext,
  StrategyOutput,
  buildSignals,
  computeIndicators,
  mapInsightToParams,
  normalizeInsight,
  scoreSignals,
  strategyRegistry,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { AgentConfigService } from './agent-config.service';
import { LlmClient, LlmResult } from './llm.client';
import { StrategyService } from './strategy.service';
import { buildContextPrompt } from './prompt';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { AccountService } from '../account/account.service';
import { PositionService } from '../account/position.service';
import { TradingService } from '../trading/trading.service';
import { RiskService } from '../trading/risk.service';
import { EventBusService } from '../common/events';

const HISTORY_LIMIT = 200;

/**
 * hybrid 链路：AI 上下文（insight）缓存有效期。
 * 上下文变化远慢于 5 分钟级 K 线，AI 调用降频到小时级可显著省 token；
 * 过期后下一轮重新调用，AI 失败期间沿用缓存，超期才回落中性参数。
 */
const INSIGHT_TTL_MS = 60 * 60 * 1000;

/** 连续失败达到该次数后熔断，停止自动调度直到冷却期结束 */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** 熔断后的冷却时长：留足时间让下游（LLM / 交易所）恢复 */
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
/** 连续失败退避基数，实际退避 = min(base * 2^(n-1), max) */
const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** 一次链路分派的产出：决策本体 + 归因元数据（落库字段来源） */
interface LaneDecision {
  /** 链路归属：strategy=纯策略；hybrid=AI 上下文 + 策略执行 */
  lane: DecisionLane;
  /** 实际产出决策的策略名（两条链路都由策略执行） */
  strategyName: string | null;
  /** 决策本体：统一由策略产出（AI 不再直出买卖指令） */
  decision: StrategyOutput;
  degraded: boolean;
  degradeReason: string | null;
  /** hybrid 链路才有：供落库 llmRaw/llmReasoning/llmModel/llmUsage（记录上下文分析） */
  llmResult: LlmResult | null;
  /** strategy 链路为空串；hybrid 链路存上下文 prompt */
  prompt: string;

  /** 出场规则触发时为 true：卖出全部持仓（而非按 positionPct 部分卖出） */
  closeAll?: boolean;

  /** 仅 hybrid 链路：AI 激进度映射的仓位乘数（0.5~1.5），作用于开仓金额 */
  positionMultiplier?: number;
}

@Injectable()
export class AgentEngine {
  private readonly logger = new Logger(AgentEngine.name);
  private running = false;

  /** hybrid 链路：缓存的 AI 上下文（元参数），带过期时间；重启后重新分析 */
  private insightCache: { insight: ContextInsight; expiresAt: number } | null = null;

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
    private readonly strategyService: StrategyService,
    private readonly positions: PositionService,
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
      // 出场检查（阶段 4）：持仓层能力，优先级最高，两条链路均生效；
      // 触发时直接以出场决策替代链路决策，策略/模型本轮不参与
      const exitResult = await this.checkExitRules(config, snapshot);
      const laneResult = exitResult ?? (await this.produceDecision(config, snapshot));
      const decision = laneResult.decision;
      const degraded = laneResult.degraded;
      const degradeReason = laneResult.degradeReason;

      this.logger.log(
        `决策完成: ${config.symbol} ${decision.action} 置信度 ${decision.confidence}` +
          `（链路 ${laneResult.lane}${degraded ? '，已降级' : ''}） 耗时 ${Date.now() - startedAt}ms`,
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
          degraded,
          degradeReason,
          riskPassed: true,
          orderId: null,
          latencyMs: 0,
        }),
      );
      this.lastDecisionId = entity.id;

      const orderId = await this.execute(
        config,
        snapshot,
        decision,
        entity.id,
        laneResult.closeAll,
        laneResult.positionMultiplier,
      );
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

  /**
   * 按配置的决策链路（decisionLane）产出决策。
   *
   * - strategy：纯策略链路，零 LLM 参与（不读 key、不发请求、零 token 成本）
   * - hybrid：AI 输出上下文元参数（1 小时 TTL 缓存），纯函数映射为策略参数后
   *   由确定性策略执行；AI 失败/过期回落中性默认参数，交易不停摆
   *
   * 注：原 llm 链路（AI 直出 BUY/SELL/HOLD）已移除——不可回测、不可复现、失败不可预测。
   * 两条链路都由确定性策略执行买卖，区别仅在于策略参数是否经 AI 元参数调节。
   */
  private async produceDecision(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision> {
    // 兼容存量数据中已废弃的 'llm' 值：按 strategy 处理（策略执行，零 LLM 直出）
    if (config.decisionLane === 'hybrid') {
      return this.buildHybridLane(config, snapshot);
    }
    return this.buildStrategyLane(config, snapshot);
  }

  /**
   * 阶段 5 · hybrid 链路：AI 只输出市场上下文元参数（regime/激进度/新闻情绪），
   * 经纯函数 mapInsightToParams 映射为策略参数后由确定性策略执行。
   *
   * 停摆保护：AI 失败或输出不合法时不中断交易——优先沿用未过期的 insight 缓存，
   * 否则回落 NEUTRAL_CONTEXT_INSIGHT（中性默认参数），degraded=true 留痕。
   */
  private async buildHybridLane(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision> {
    const prompt = buildContextPrompt(snapshot);
    const cached = this.insightCache;
    let insight: ContextInsight;
    let degraded = false;
    let degradeReason: string | null = null;
    let llmResult: LlmResult | null = null;

    if (cached && cached.expiresAt > Date.now()) {
      insight = cached.insight;
    } else {
      const result = await this.llm.analyzeContext(
        config.systemPrompt,
        prompt,
        config.model,
        config.temperature,
        config.maxTokens,
      );
      if (result.ok && result.insight) {
        insight = normalizeInsight(result.insight);
        this.insightCache = { insight, expiresAt: Date.now() + INSIGHT_TTL_MS };
        llmResult = result;
      } else {
        // 缓存已过期但 AI 失败：超期缓存仍比中性默认更贴近当前市场，优先沿用
        if (cached) {
          insight = cached.insight;
          degraded = true;
          degradeReason = `AI 上下文调用失败，沿用上次分析（已超期）：${result.error ?? '未知原因'}`;
        } else {
          insight = NEUTRAL_CONTEXT_INSIGHT;
          degraded = true;
          degradeReason = `AI 上下文不可用，使用中性默认参数继续运行：${result.error ?? '未知原因'}`;
        }
        llmResult = result;
      }
    }

    // 阈值基准 = 策略默认参数与用户 strategyParams 合并后的当前入场阈值
    const baseParams = strategyRegistry.getOrDefault(config.strategyName).strategy.defaultParams;
    const mapped = mapInsightToParams(insight, config.strategyName, {
      ...baseParams,
      ...config.strategyParams,
    });
    // 用户配置的 strategyParams 为基底，AI 映射参数覆盖同名项（AI 只调元参数，不碰其余配置）
    const params = { ...config.strategyParams, ...mapped };
    const lane = await this.buildStrategyLane(config, snapshot, params);
    return {
      ...lane,
      lane: 'hybrid',
      degraded: lane.degraded || degraded,
      degradeReason: lane.degradeReason ?? degradeReason,
      prompt,
      positionMultiplier: mapped.positionMultiplier,
      llmResult,
    };
  }

  /** 构造纯策略链路的决策（strategy 链路本体，hybrid 链路也复用本方法执行买卖） */
  private async buildStrategyLane(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
    paramsOverride?: Record<string, unknown>,
  ): Promise<LaneDecision> {
    // 策略上下文补持仓快照（阶段 4 出场规则的前置）；buildSnapshot 的其余数据保持同构复用
    const position = await this.positions.getPosition(config.symbol);
    const context: Omit<StrategyContext, 'params'> = {
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      candles: snapshot.candles,
      indicators: snapshot.indicators,
      signals: snapshot.signals,
      indicatorScore: snapshot.indicatorScore,
      ticker: snapshot.ticker,
      position,
      account: { quoteFree: snapshot.account.quoteFree, baseFree: snapshot.account.baseFree },
    };
    const { output, strategyName, fellBack } = this.strategyService.evaluate(
      config.strategyName,
      context,
      paramsOverride ?? config.strategyParams,
    );
    return {
      lane: 'strategy',
      strategyName,
      decision: output,
      // 配置了不存在的策略名 → 记录降级原因，而非静默回退
      degraded: fellBack,
      degradeReason: fellBack ? `策略 ${config.strategyName} 不存在，已回退 ${strategyName}` : null,
      llmResult: null,
      prompt: '',
    };
  }

  /**
   * 出场规则检查（阶段 4）：持仓层能力，两条链路均生效，优先级最高。
   * 持仓亏损触及止损或盈利达到止盈时，产出全仓卖出决策，替代本轮策略/模型决策。
   * 默认全关（exitRules 两项均为 null），不配置则完全不参与决策流程。
   */
  private async checkExitRules(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision | null> {
    const { stopLossPct, takeProfitPct } = config.exitRules ?? {};
    if (stopLossPct == null && takeProfitPct == null) return null;

    const position = await this.positions.getPosition(config.symbol);
    if (!position || !(position.quantity > 0) || !(position.avgCost > 0)) return null;

    const price = snapshot.ticker.price || snapshot.indicators.lastClose;
    if (!(price > 0)) return null;

    const pnlPct = (price - position.avgCost) / position.avgCost;

    let trigger: string | null = null;
    if (stopLossPct != null && pnlPct <= -stopLossPct) {
      trigger =
        `止损触发：现价 ${price.toFixed(2)} 较持仓均价 ${position.avgCost.toFixed(2)} ` +
        `亏损 ${(pnlPct * 100).toFixed(2)}%，达到 -${(stopLossPct * 100).toFixed(2)}% 阈值`;
    } else if (takeProfitPct != null && pnlPct >= takeProfitPct) {
      trigger =
        `止盈触发：现价 ${price.toFixed(2)} 较持仓均价 ${position.avgCost.toFixed(2)} ` +
        `盈利 ${(pnlPct * 100).toFixed(2)}%，达到 +${(takeProfitPct * 100).toFixed(2)}% 阈值`;
    }
    if (!trigger) return null;

    this.logger.warn(`出场规则触发 → 全仓卖出：${trigger}`);
    return {
      lane: 'strategy',
      strategyName: null,
      degraded: true,
      degradeReason: `出场规则触发（优先级高于策略/模型信号）：${trigger}`,
      llmResult: null,
      prompt: '',
      closeAll: true,
      decision: {
        action: 'SELL',
        confidence: 1,
        reason: `出场规则触发：${trigger}。按出场规则全仓卖出。`,
        riskNotes: '出场规则属于持仓层能力，两条链路均生效，优先级高于开仓信号。',
      },
    };
  }

  /** 风控校验 + 下单 */
  private async execute(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
    decision: StrategyOutput,
    decisionId: string,
    closeAll = false,
    positionMultiplier?: number,
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
    // 出场规则触发（closeAll）时卖出全部持仓，常规决策仍按 positionPct 部分卖出
    // hybrid 链路的 AI 激进度映射为开仓乘数（0.5~1.5），仅放大/收缩开仓，卖出不受影响
    const buyMultiplier =
      decision.action === 'BUY' && positionMultiplier != null
        ? Math.min(1.5, Math.max(0.5, positionMultiplier))
        : 1;
    const quantity =
      side === 'BUY'
        ? (snapshot.account.quoteFree * config.positionPct * buyMultiplier) / price
        : closeAll
          ? snapshot.account.baseFree
          : snapshot.account.baseFree * config.positionPct;

    if (!(quantity > 0)) {
      this.lastRiskVerdict = {
        passed: false,
        rejectedBy: 'INSUFFICIENT_BALANCE',
        note: '按仓位比例计算出的下单数量为 0，可用余额不足',
      };
      return null;
    }

    // 按交易所精度预取整：数量不足最小下单单位（典型场景：SELL 无持仓或仓位比例太小）
    // → 作为风控拦截处理而非抛错，避免无意义的失败退避与熔断
    const filters = await this.trading.getFilters(config.symbol);
    const step = filters.stepSize > 0 ? filters.stepSize : 1e-8;
    const minQty = filters.minQty > 0 ? filters.minQty : step;
    const roundedQty = Math.floor(quantity / step) * step;
    if (!(roundedQty >= minQty && roundedQty > 0)) {
      const note =
        side === 'SELL'
          ? `无持仓可卖：卖出量 ${quantity.toFixed(8)} 不足最小下单单位 ${minQty}（可能没有持仓或 positionPct 太小），本轮跳过`
          : `买入量 ${quantity.toFixed(8)} 不足最小下单单位 ${minQty}（资金或 positionPct 太小），本轮跳过`;
      this.lastRiskVerdict = { passed: false, rejectedBy: 'MIN_QTY', note };
      await this.risk.record('limit', 'info', note, config.symbol, decisionId);
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
      // 存量数据可能残留已废弃的 'llm'（AI 直出链路），读时归一为 strategy
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

  async list(params: {
    page?: number;
    pageSize?: number;
    action?: DecisionAction;
    executedOnly?: boolean;
    keyword?: string;
    lane?: DecisionLane;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));

    const qb = this.decisionRepo.createQueryBuilder('d');
    if (params.action) qb.andWhere('d.action = :action', { action: params.action });
    if (params.lane) qb.andWhere('d.lane = :lane', { lane: params.lane });
    if (params.executedOnly) qb.andWhere('d.orderId IS NOT NULL');
    if (params.keyword) {
      qb.andWhere('(d.reason ILIKE :kw OR d.riskNotes ILIKE :kw)', { kw: `%${params.keyword}%` });
    }
    qb.orderBy('d.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);

    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((r) => this.toSummary(r)), total, page, pageSize };
  }

  /**
   * 决策链路统计（阶段 6）：按链路分组的决策量、降级量与动作分布，
   * 供决策历史页顶部统计条使用。
   */
  async laneStats(): Promise<{
    total: number;
    degradedTotal: number;
    lanes: { lane: DecisionLane; count: number; degraded: number; buys: number; sells: number; holds: number }[];
  }> {
    const rows = await this.decisionRepo
      .createQueryBuilder('d')
      .select('d.lane', 'lane')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(CASE WHEN d.degraded THEN 1 ELSE 0 END)', 'degraded')
      .addSelect("SUM(CASE WHEN d.action = 'BUY' THEN 1 ELSE 0 END)", 'buys')
      .addSelect("SUM(CASE WHEN d.action = 'SELL' THEN 1 ELSE 0 END)", 'sells')
      .addSelect("SUM(CASE WHEN d.action = 'HOLD' THEN 1 ELSE 0 END)", 'holds')
      .groupBy('d.lane')
      .getRawMany<{ lane: string | null; count: string; degraded: string; buys: string; sells: string; holds: string }>();

    const lanes = rows.map((r) => ({
      lane: (r.lane ?? 'llm') as DecisionLane,
      count: Number(r.count),
      degraded: Number(r.degraded ?? 0),
      buys: Number(r.buys ?? 0),
      sells: Number(r.sells ?? 0),
      holds: Number(r.holds ?? 0),
    }));
    return {
      total: lanes.reduce((acc, l) => acc + l.count, 0),
      degradedTotal: lanes.reduce((acc, l) => acc + l.degraded, 0),
      lanes,
    };
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
