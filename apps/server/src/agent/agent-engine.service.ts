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
  MarketType,
  StrategyOutput,
  computeSpotOrderQty,
  evaluateExitRules,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { AgentDecisionEntity } from '../database/entities';
import { AgentConfigService } from './agent-config.service';
import { DecisionCoreService, LaneDecision } from './decision-core.service';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { AccountService } from '../account/account.service';
import { PositionService } from '../account/position.service';
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
    private readonly core: DecisionCoreService,
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
          // 接近度 + 结构化归因：让每一条 HOLD 都可解释（知道差多少、谁拖后腿）
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

  /**
   * 构造决策输入快照。
   *
   * 指标/信号/新闻由共享决策内核计算（L0~L3 现货与合约完全一致），
   * 账户口径是现货的「USDT/BTC 可用余额」（合约引擎传可用保证金与净持仓）。
   */
  private async buildSnapshot(
    config: AgentConfigShape,
    candles: Candle[],
  ): Promise<DecisionInputSnapshot> {
    const ticker = this.market.getTicker(config.symbol);
    const recentNews = await this.news.getRecent(6);
    const balances = await this.accounts.getBalances(config.mode, config.enabledExchanges);

    const quoteFree = balances.rows
      .filter((r) => r.asset === 'USDT')
      .reduce((acc, r) => acc + r.free, 0);
    const baseFree = balances.rows
      .filter((r) => r.asset === 'BTC')
      .reduce((acc, r) => acc + r.free, 0);

    return this.core.buildSnapshot({
      symbol: config.symbol,
      timeframe: config.timeframe,
      candles,
      ticker,
      // 按策略语义构造信号（B3）：趋势策略的 RSI 读作动能，避免方向反转
      strategyName: config.strategyName,
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
        source: balances.source,
      },
    });
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
  /**
   * 按配置的决策链路（decisionLane）产出决策。
   *
   * 实际计算全部委托给共享决策内核（L0~L3），现货与合约走同一份实现：
   * 指标 → 信号 → 策略插件 → 决策。本方法只负责补齐现货的持仓快照。
   */
  private async produceDecision(
    config: AgentConfigShape,
    snapshot: DecisionInputSnapshot,
  ): Promise<LaneDecision> {
    const position = await this.positions.getPosition(config.symbol);
    return this.core.produceDecision(
      {
        decisionLane: config.decisionLane,
        strategyName: config.strategyName,
        strategyParams: config.strategyParams,
        systemPrompt: config.systemPrompt,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        insightCacheKey: 'spot',
      },
      snapshot,
      position,
    );
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

    // 现货只有多头（side=null），出场判定与合约共用同一纯函数
    const exit = evaluateExitRules({
      entryPrice: position.avgCost,
      price,
      side: null,
      exitRules: config.exitRules,
    });
    if (!exit.triggered) return null;

    this.logger.warn(`出场规则触发 → 全仓卖出：${exit.reason}`);
    return {
      lane: 'strategy',
      strategyName: null,
      degraded: true,
      degradeReason: `出场规则触发（优先级高于策略/模型信号）：${exit.reason}`,
      llmResult: null,
      prompt: '',
      closeAll: true,
      decision: {
        // 现货恒为卖出；合约由 FuturesEngine 按方向取 exit.closeAction
        action: 'SELL',
        confidence: 1,
        reason: `出场规则触发：${exit.reason}。按出场规则全仓卖出。`,
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
    // 数量公式下沉到 shared 的纯函数，与 SpotExecutor 共用同一实现：
    // 出场规则触发（closeAll）时卖出全部持仓，常规决策仍按 positionPct 部分卖出；
    // hybrid 链路的 AI 激进度映射为开仓乘数（0.5~1.5），仅放大/收缩开仓，卖出不受影响。
    const quantity = computeSpotOrderQty({
      action: decision.action,
      quoteFree: snapshot.account.quoteFree,
      baseFree: snapshot.account.baseFree,
      positionPct: config.positionPct,
      price,
      positionMultiplier,
      closeAll,
    });

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
      // 存量可能残留已废弃的 'llm'，读时归一为 strategy
      lane: (r.lane === 'hybrid' ? 'hybrid' : 'strategy') as DecisionLane,
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

  /**
   * 决策诊断聚合（策略增强方案 A 期）：回答「为什么没开单」。
   *
   * 借鉴 EasyQuant Blocking Reasons 的排障顺序：**先看 Top 原因聚合，再看单条明细**。
   * 某个原因码长期霸榜 Top1，说明是系统性问题而非个案。
   *
   * 四类输出：
   * 1. topReasons —— 阻塞原因码 Top 排行（含占比）
   * 2. proximityBuckets —— 接近度分布，识别「差一点就开仓」的堆积区间
   * 3. nearMisses —— 最接近触发的若干条观望，供直接下钻
   * 4. signalStats —— 各信号投票率（弃权/多/空），暴露「信号不表态」问题
   */
  async diagnostics(options: { windowHours?: number; market?: MarketType } = {}) {
    const windowHours = Math.max(1, Math.min(24 * 30, Number(options.windowHours) || 24));
    const since = new Date(Date.now() - windowHours * 3600_000);

    // ① 阻塞原因 Top
    //
    // 关键：阻塞可能发生在**两个不同层级**，必须都统计，否则会归因到错误的层：
    //   - 策略层：blockingReason（如 SIGNAL_NONE = 信号未达阈值）
    //   - 风控层：riskRejectedBy（如 MAX_ORDER_AMOUNT = 金额超限被拒）
    // 「信号正常触发但被风控拒单」是常见情况，只看 blockingReason 会误判成"信号没触发"。
    // 用 COALESCE 取前者，为空时回落到映射后的风控码。
    const reasonRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select(
        `COALESCE(d."blockingReason", CASE d."riskRejectedBy"
           WHEN 'MIN_ORDER_INTERVAL' THEN 'RISK_INTERVAL'
           WHEN 'MAX_ORDER_AMOUNT' THEN 'RISK_MAX_ORDER_AMOUNT'
           WHEN 'MAX_DAILY_ORDERS' THEN 'RISK_MAX_DAILY_ORDERS'
           WHEN 'DAILY_LOSS_LIMIT' THEN 'RISK_DAILY_LOSS'
           WHEN 'MAX_DRAWDOWN' THEN 'RISK_DRAWDOWN'
           WHEN 'INSUFFICIENT_BALANCE' THEN 'RISK_INSUFFICIENT_BALANCE'
           WHEN 'MAX_EXPOSURE' THEN 'RISK_MAX_EXPOSURE'
           WHEN 'LIVE_MODE_CONFIRM_REQUIRED' THEN 'RISK_CONFIRM_REQUIRED'
           WHEN 'INVALID_QUANTITY' THEN 'RISK_MIN_NOTIONAL'
           WHEN 'MIN_CONFIDENCE' THEN 'BELOW_MIN_CONFIDENCE'
           WHEN 'MIN_QTY' THEN 'RISK_MIN_NOTIONAL'
           WHEN 'NO_PRICE' THEN 'STALE_DATA'
           WHEN 'RISK_MARGIN' THEN 'RISK_MARGIN'
           WHEN 'LIQUIDATION_DIST' THEN 'RISK_LIQUIDATION_DIST'
           WHEN 'LEVERAGE_CLAMPED' THEN 'RISK_LEVERAGE_CLAMPED'
           WHEN 'BROKER_REJECTED' THEN 'BROKER_REJECTED'
           ELSE NULL END)`,
        'code',
      )
      .addSelect('COUNT(*)', 'count')
      .where('d."createdAt" >= :since', { since })
      .andWhere(
        `(d."blockingReason" IS NOT NULL OR d."riskRejectedBy" IS NOT NULL)`,
      )
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .groupBy('code')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany<{ code: string; count: string }>();

    const blockedTotal = reasonRows.reduce((acc, r) => acc + Number(r.count), 0);
    const topReasons = reasonRows.map((r) => ({
      code: r.code,
      count: Number(r.count),
      share: blockedTotal === 0 ? 0 : Number((Number(r.count) / blockedTotal).toFixed(4)),
    }));

    // ② 接近度分布：0~1 分 5 桶，看观望决策堆积在哪个区间
    const bucketRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select(
        `CASE
           WHEN d.proximity IS NULL THEN 'unknown'
           WHEN d.proximity < 0.2 THEN '0.0-0.2'
           WHEN d.proximity < 0.4 THEN '0.2-0.4'
           WHEN d.proximity < 0.6 THEN '0.4-0.6'
           WHEN d.proximity < 0.8 THEN '0.6-0.8'
           WHEN d.proximity < 1.0 THEN '0.8-1.0'
           ELSE '1.0'
         END`,
        'bucket',
      )
      .addSelect('COUNT(*)', 'count')
      .where('d."createdAt" >= :since', { since })
      .andWhere("d.action = 'HOLD'")
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .groupBy('bucket')
      .getRawMany<{ bucket: string; count: string }>();

    const proximityBuckets = bucketRows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));

    // ③ 最接近触发的观望（差一点就开仓的），供直接下钻
    const nearMissRows = await this.decisionRepo
      .createQueryBuilder('d')
      // 注意：字段必须写 'd.createdAt'（不带引号），带引号会导致 TypeORM 无法映射、返回 undefined
      .select(['d.id', 'd.createdAt', 'd.action', 'd.proximity', 'd.blockingReason', 'd.diagnostics'])
      .where('d."createdAt" >= :since', { since })
      .andWhere("d.action = 'HOLD'")
      .andWhere('d.proximity IS NOT NULL')
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .orderBy('d.proximity', 'DESC')
      .take(20)
      .getMany();

    const nearMisses = nearMissRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt?.toISOString() ?? null,
      proximity: r.proximity,
      blockingReason: r.blockingReason,
      score: r.diagnostics?.score ?? null,
      requiredScore: r.diagnostics?.requiredScore ?? null,
      contributions: r.diagnostics?.contributions ?? [],
    }));

    // ④ 信号投票率：从最近若干条带 diagnostics 的决策中统计各信号的中性/多/空占比。
    //    直接暴露「信号长期不表态」问题（如 bollinger 约 80% 时间 neutral）。
    const sampleRows = await this.decisionRepo
      .createQueryBuilder('d')
      .select(['d.diagnostics'])
      .where('d."createdAt" >= :since', { since })
      .andWhere('d.diagnostics IS NOT NULL')
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .orderBy('d."createdAt"', 'DESC')
      .take(500)
      .getMany();

    const signalMap = new Map<string, { label: string; total: number; neutral: number; bullish: number; bearish: number }>();
    for (const row of sampleRows) {
      for (const c of row.diagnostics?.contributions ?? []) {
        const cur = signalMap.get(c.name) ?? { label: c.label, total: 0, neutral: 0, bullish: 0, bearish: 0 };
        cur.total += 1;
        if (c.bias === 'neutral') cur.neutral += 1;
        else if (c.bias === 'bullish') cur.bullish += 1;
        else cur.bearish += 1;
        signalMap.set(c.name, cur);
      }
    }
    const signalStats = [...signalMap.entries()].map(([name, v]) => ({
      name,
      label: v.label,
      total: v.total,
      neutralRate: v.total === 0 ? 0 : Number((v.neutral / v.total).toFixed(4)),
      bullishRate: v.total === 0 ? 0 : Number((v.bullish / v.total).toFixed(4)),
      bearishRate: v.total === 0 ? 0 : Number((v.bearish / v.total).toFixed(4)),
    }));

    const total = await this.decisionRepo
      .createQueryBuilder('d')
      .where('d."createdAt" >= :since', { since })
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .getCount();

    const holdTotal = await this.decisionRepo
      .createQueryBuilder('d')
      .where('d."createdAt" >= :since', { since })
      .andWhere("d.action = 'HOLD'")
      .andWhere(options.market ? 'd.market = :market' : '1=1', options.market ? { market: options.market } : {})
      .getCount();

    return { windowHours, total, holdTotal, topReasons, proximityBuckets, nearMisses, signalStats };
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
