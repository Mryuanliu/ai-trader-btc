import { Injectable, Logger } from '@nestjs/common';
import {
  Candle,
  ContextInsight,
  DecisionInputSnapshot,
  DecisionLane,
  NEUTRAL_CONTEXT_INSIGHT,
  PositionSnapshot,
  StrategyContext,
  StrategyOutput,
  buildSignals,
  computeIndicators,
  mapInsightToParams,
  normalizeInsight,
  scoreSignals,
  strategyRegistry,
} from '@ai-trader/shared';
import { LlmClient, LlmResult } from './llm.client';
import { StrategyService } from './strategy.service';
import { buildContextPrompt } from './prompt';

/**
 * hybrid 链路 AI 上下文缓存有效期。
 * 上下文变化远慢于 5 分钟级 K 线，降频到小时级可显著省 token；
 * 过期后下一轮重新调用，AI 失败期间沿用缓存，超期才回落中性参数。
 */
const INSIGHT_TTL_MS = 60 * 60 * 1000;

/** 一次链路分派的产出：决策本体 + 归因元数据（落库字段来源） */
export interface LaneDecision {
  lane: DecisionLane;
  /** 实际产出决策的策略名（两条链路都由策略执行） */
  strategyName: string | null;
  /** 决策本体：统一由策略产出（AI 不直出买卖指令） */
  decision: StrategyOutput;
  degraded: boolean;
  degradeReason: string | null;
  /** hybrid 链路才有：供落库 llmRaw/llmReasoning/llmModel/llmUsage */
  llmResult: LlmResult | null;
  /** strategy 链路为空串；hybrid 链路存上下文 prompt */
  prompt: string;
  /** 出场规则触发时为 true：全部平仓（而非按 positionPct 部分处理） */
  closeAll?: boolean;
  /** 仅 hybrid 链路：AI 激进度映射的仓位乘数（0.5~1.5） */
  positionMultiplier?: number;
}

/**
 * 决策内核（L0~L3）：指标 → 信号 → 策略插件 → 决策产出。
 *
 * 现货与合约**完全共用**本服务：K 线、指标、信号、策略插件、链路分派
 * 都不含任何市场差异。市场的差异从 L4（执行）才开始出现。
 *
 * 本服务只做「产出决策」，不做下单、不读持仓、不碰数据库——
 * 这些由各自引擎按市场口径实现。
 */
@Injectable()
export class DecisionCoreService {
  private readonly logger = new Logger(DecisionCoreService.name);

  /**
   * hybrid 链路 AI 上下文缓存（带过期时间）；重启后重新分析。
   *
   * **按市场隔离**：本服务是现货与合约共用的单例，若共用一份缓存，
   * 合约引擎会复用由现货数据算出的上下文（反之亦然），
   * 导致合约决策记录里没有自己的 LLM 调用留痕（llmModel/usage 为空却未标记降级），
   * 无法归因与审计。缓存键由调用方传入（spot / futures）。
   */
  private readonly insightCache = new Map<
    string,
    { insight: ContextInsight; expiresAt: number }
  >();

  constructor(
    private readonly llm: LlmClient,
    private readonly strategyService: StrategyService,
  ) {}

  /**
   * 由 K 线构造决策输入快照（指标、信号、新闻由调用方注入）。
   *
   * 账户状态由调用方传入：现货用「USDT/BTC 可用余额」，合约会传
   * 「可用保证金 / 净持仓」，语义不同但结构同构，策略层无需感知。
   */
  buildSnapshot(input: {
    symbol: string;
    timeframe: DecisionInputSnapshot['timeframe'];
    candles: Candle[];
    ticker: DecisionInputSnapshot['ticker'];
    news: DecisionInputSnapshot['news'];
    account: DecisionInputSnapshot['account'];
  }): DecisionInputSnapshot {
    const indicators = computeIndicators(input.candles);
    const signals = buildSignals(indicators, input.candles);
    const indicatorScore = scoreSignals(signals);

    return {
      symbol: input.symbol,
      timeframe: input.timeframe,
      candles: input.candles,
      ticker: input.ticker,
      indicators,
      signals,
      indicatorScore,
      news: input.news,
      account: input.account,
    };
  }

  /**
   * 按链路分派产出决策（strategy=纯策略；hybrid=AI 上下文 + 策略执行）。
   *
   * `insightCacheKey` 用于隔离各市场的 AI 上下文缓存，通常传 market（spot / futures）。
   */
  async produceDecision(
    input: {
      decisionLane: DecisionLane;
      strategyName: string;
      strategyParams: Record<string, unknown>;
      systemPrompt: string;
      model: string;
      temperature: number;
      maxTokens: number;
      insightCacheKey: string;
    },
    snapshot: DecisionInputSnapshot,
    position: PositionSnapshot,
  ): Promise<LaneDecision> {
    // 兼容存量数据中已废弃的 'llm' 值：按 strategy 处理（策略执行，零 LLM 直出）
    if (input.decisionLane === 'hybrid') {
      return this.buildHybridLane(input, snapshot, position);
    }
    return this.buildStrategyLane(input, snapshot, position);
  }

  /**
   * hybrid 链路：AI 只输出市场上下文元参数（regime/激进度/新闻情绪），
   * 经纯函数 mapInsightToParams 映射为策略参数后由确定性策略执行。
   *
   * 停摆保护：AI 失败或输出不合法时不中断交易——优先沿用未过期的缓存，
   * 否则回落 NEUTRAL_CONTEXT_INSIGHT（中性默认参数），degraded=true 留痕。
   */
  private async buildHybridLane(
    input: Parameters<DecisionCoreService['produceDecision']>[0],
    snapshot: DecisionInputSnapshot,
    position: PositionSnapshot,
  ): Promise<LaneDecision> {
    const cacheKey = input.insightCacheKey || 'default';
    const prompt = buildContextPrompt(snapshot);
    const cached = this.insightCache.get(cacheKey) ?? null;
    let insight: ContextInsight;
    let degraded = false;
    let degradeReason: string | null = null;
    let llmResult: LlmResult | null = null;

    if (cached && cached.expiresAt > Date.now()) {
      insight = cached.insight;
    } else {
      const result = await this.llm.analyzeContext(
        input.systemPrompt,
        prompt,
        input.model,
        input.temperature,
        input.maxTokens,
      );
      if (result.ok && result.insight) {
        insight = normalizeInsight(result.insight);
        this.insightCache.set(cacheKey, { insight, expiresAt: Date.now() + INSIGHT_TTL_MS });
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
    const baseParams = strategyRegistry.getOrDefault(input.strategyName).strategy.defaultParams;
    const mapped = mapInsightToParams(insight, input.strategyName, {
      ...baseParams,
      ...input.strategyParams,
    });
    // 用户 strategyParams 为基底，AI 映射参数覆盖同名项（AI 只调元参数，不碰其余配置）
    const params = { ...input.strategyParams, ...mapped };
    const lane = await this.buildStrategyLane(input, snapshot, position, params);
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

  /** 纯策略链路（strategy 本体，hybrid 链路也复用本方法执行买卖） */
  private async buildStrategyLane(
    input: Parameters<DecisionCoreService['produceDecision']>[0],
    snapshot: DecisionInputSnapshot,
    position: PositionSnapshot,
    paramsOverride?: Record<string, unknown>,
  ): Promise<LaneDecision> {
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
      input.strategyName,
      context,
      paramsOverride ?? input.strategyParams,
    );
    return {
      lane: 'strategy',
      strategyName,
      decision: output,
      // 配置了不存在的策略名 → 记录降级原因，而非静默回退
      degraded: fellBack,
      degradeReason: fellBack ? `策略 ${input.strategyName} 不存在，已回退 ${strategyName}` : null,
      llmResult: null,
      prompt: '',
    };
  }
}
