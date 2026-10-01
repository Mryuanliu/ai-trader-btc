import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { atr } from '@ai-trader/shared';
import type {
  BlockingLot,
  Candle,
  FuturesPositionSnapshot,
  StrategyStartResult,
} from '@ai-trader/shared';
import { EventBusService } from '../common/events';
import { MarketService } from '../market/market.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { FuturesPositionService } from '../futures/futures-position.service';
import { LotService } from '../account/lot.service';
import { BasketService } from '../account/basket.service';
import { StrategyRegistry } from './strategy-registry.service';
import { StrategyExecutorService } from './strategy-executor.service';
import { StrategyInstanceService } from './strategy-instance.service';
import { ProtectionService, ProtectionVerdict } from './protection.service';
import type {
  StrategyContext,
  StrategyDescriptor,
  StrategyExecutor,
  StrategyLotView,
  StrategyRunStatus,
  TradingStrategy,
} from './types';

/** tick 上下文使用的 K 线根数：够算 ATR14 与 30 周期均线并留余量 */
const CONTEXT_CANDLE_LIMIT = 150;

/**
 * 两次 tick 的最小间隔（节流）。
 *
 * 行情是推送式的（约 1s 一帧），但每帧都跑完整策略没有意义：
 * 一次 tick 含多次 DB 查询与交易所回查，高频跑只会消耗配额与算力。
 * 800ms 既能跟上推送节奏，也把止盈判定的延迟从轮询时代的 5s 压到 1s 以内。
 */
const MIN_TICK_INTERVAL_MS = 800;

/**
 * 策略运行器。
 *
 * 取代原「决策引擎」：不再周期产出 BUY/SELL/HOLD 决策，
 * 而是挂载一个策略实例并周期调用它的 `onTick`，由策略自行决定开仓/挂单/平仓。
 *
 * 同时只允许一个策略运行——切换策略前必须先停掉当前策略，
 * 且**存在未完结仓位单时拒绝启动**（那些单子是上一个策略留下的，
 * 语义上归它管，需要用户手动了结，避免两套策略的仓位混在一起）。
 */
@Injectable()
export class StrategyRunner implements OnModuleInit {
  private readonly logger = new Logger(StrategyRunner.name);

  /** 运行中的策略实例表（P2 多实例）：key = `策略名:交易对` */
  private readonly instances = new Map<
    string,
    {
      instanceId: string;
      strategyName: string;
      symbol: string;
      strategy: TradingStrategy;
      params: Record<string, unknown>;
      startedAt: Date;
    }
  >();

  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  /** tick 重入保护：上一次还没跑完就跳过本轮 */
  private ticking = false;
  /** 上一次 tick 时的运行模式：变化时撤销旧挂单（见 tick 内注释） */
  private lastMode: string | null = null;
  /** 上一次 tick 的毫秒时间戳：用于节流（行情事件驱动时每帧都会进来） */
  private lastTickMs = 0;

  constructor(
    private readonly registry: StrategyRegistry,
    private readonly executor: StrategyExecutorService,
    private readonly market: MarketService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly trading: FuturesTradingService,
    private readonly positions: FuturesPositionService,
    private readonly lots: LotService,
    private readonly baskets: BasketService,
    private readonly instanceService: StrategyInstanceService,
    private readonly protection: ProtectionService,
    private readonly events: EventBusService,
  ) {
    this.subscribePriceTicks();
    this.subscribeProtections();
  }

  /**
   * 行情事件驱动 tick：价格一变就驱动策略，而不是干等 5 秒轮询。
   *
   * 区分两类触发：
   * - **网格挂单**：STOP_MARKET 由**交易所**触发，不需要我们盯，天然即时 ✓
   * - **篮子止盈/加层判定**：是我们自己的逻辑，靠轮询会有最多 5 秒延迟——
   *   行情剧烈时，这几秒可能已经从浮盈变浮亏。
   *   WebSocket 是推送式的，价格到达即触发，延迟降到毫秒级。
   *
   * 调度器的 5 秒轮询**保留作兜底**（WS 断线时策略仍能继续运行）。
   */
  private subscribePriceTicks(): void {
    this.events.on$('price').subscribe(() => {
      if (this.instances.size === 0) return;
      void this.tick().catch((err) => this.logger.warn(`行情驱动 tick 异常: ${err.message}`));
    });
  }

  /**
   * 熔断守卫（D4）：订阅篮子了结事件，按实例归因评估是否触发平台侧兜底。
   *
   * 挂载在 `basketClosed` 而非 tick 热循环——篮子首次 OPEN→CLOSED 才是「一笔」的落定，
   * 每篮查一次库远比每帧查库经济。只对**当前正在运行**的实例评估（多实例隔离），
   * 命中即调 `tripProtection` 停实例。**不平任何持仓**，沿用 stop 的「持仓保留、需手动处理」语义。
   */
  private subscribeProtections(): void {
    this.events.on$('basketClosed').subscribe((e) => {
      if (!e.strategyInstanceId) return;
      if (!this.instances.has(e.strategyInstanceId)) return;
      void this.evaluateProtection(e.strategyInstanceId).catch((err) =>
        this.logger.warn(`熔断评估异常（${e.strategyInstanceId}）: ${(err as Error).message}`),
      );
    });
  }

  /** 评估单实例熔断：命中则停实例并发 protectionTripped 事件 */
  private async evaluateProtection(instanceId: string): Promise<void> {
    const verdict = await this.protection.evaluate(instanceId);
    if (verdict.halt) await this.tripProtection(instanceId, verdict);
  }

  /**
   * 触发熔断：停掉实例（撤挂单 + 清 shouldRun，重启不自动拉起）+ 留痕 + 广播。
   *
   * 语义与手动停止**完全一致**——断路器保持打开，须用户显式重启，绝不自动复位、绝不平仓。
   * `strategyName`/`symbol` 在 `stopInstance` 前先从实例表取出（stop 会 delete 该条目）。
   */
  private async tripProtection(instanceId: string, verdict: ProtectionVerdict): Promise<void> {
    const inst = this.instances.get(instanceId);
    const strategyName = inst?.strategyName ?? instanceId.split(':')[0];
    const symbol = inst?.symbol ?? instanceId.split(':')[1] ?? '';
    this.logger.warn(
      `⚠️ 熔断触发，停实例 ${instanceId}：${verdict.reason}（连亏 ${verdict.consecutiveLosses} 笔 / 回撤 ${verdict.drawdownPct.toFixed(2)}%）——持仓保留，需手动处理`,
    );
    await this.stopInstance(instanceId);
    this.events.emit('protectionTripped', {
      instanceId,
      strategyName,
      symbol,
      reason: verdict.reason,
      consecutiveLosses: verdict.consecutiveLosses,
      drawdownPct: verdict.drawdownPct,
      ts: Date.now(),
    });
  }

  isRunning(): boolean {
    return this.instances.size > 0;
  }

  list(): StrategyDescriptor[] {
    return this.registry.list();
  }

  /**
   * 启动策略。
   *
   * 默认拒绝在「存在未完结仓位单」时启动——那是上一个策略留下的仓位，
   * 两套策略的仓位混在一起无法归因。
   *
   * 但**服务重启后策略状态会丢失**（runner 是内存状态），此时自己的仓位
   * 反而会把自己挡住，形成死锁。因此提供 `adoptExisting`：确认这些仓位
   * 由当前策略接管，则跳过拦截直接启动（前端会弹窗让用户明确选择）。
   */
  /** 启动策略（兼容入口：用平台配置的默认交易对） */
  async start(
    name: string,
    rawParams?: Record<string, unknown>,
    opts?: { adoptExisting?: boolean },
  ): Promise<StrategyStartResult> {
    const symbol = (await this.futuresConfig.get()).symbol;
    return this.startInstance(name, symbol, rawParams, opts);
  }

  /**
   * 启动一个策略运行实例（P2 多实例核心）。
   *
   * `instanceId = 策略名:交易对`：同策略可跑不同交易对、同交易对可跑不同策略。
   * 拦截语义（多实例版）：只看**无归属**的未完结 Lot——
   * 归属其他实例的不算阻塞（互不干扰正是多实例的意义）。
   */
  async startInstance(
    name: string,
    symbol: string,
    rawParams?: Record<string, unknown>,
    opts?: { adoptExisting?: boolean },
  ): Promise<StrategyStartResult> {
    const instanceId = `${name}:${symbol}`;
    const existing = this.instances.get(instanceId);
    if (existing) {
      return {
        ok: false,
        status: await this.getStatus(),
        message: `实例「${existing.strategy.label} @ ${symbol}」正在运行，请先停止它`,
      };
    }

    const strategy = this.registry.get(name);
    if (!strategy) {
      return { ok: false, status: await this.getStatus(), message: `未知策略：${name}` };
    }

    // 启动前先与交易所对账：归档「交易所已平、本地仍 OPEN」的孤儿 Lot。
    // 缺这一步的话，用户在交易所平完仓后本地 Lot 仍拦着，策略永远启不来。
    // 两个安全阀（2026-09-28 误归档事故的修复）：
    // ① hedge 模式多空可同时持仓，必须**分方向**对账，不能用净持仓——
    //    多 0.04 + 空 0.02 的净持仓是 +0.02，按「净值为正=无空头」会误杀真实空头；
    // ② 持仓读取失败时跳过归档——空列表会被当成「无持仓」而把全部 Lot 误归档。
    let snaps: FuturesPositionSnapshot[] | null = null;
    try {
      snaps = await this.positions.listPositions(symbol);
    } catch (err) {
      this.logger.warn(
        `启动前对账跳过：读取交易所持仓失败（${(err as Error).message}），本次不归档孤儿 Lot`,
      );
    }
    if (snaps) {
      const longQty = snaps.filter((p) => p.quantity > 0).reduce((a, p) => a + p.quantity, 0);
      const shortQty = snaps.filter((p) => p.quantity < 0).reduce((a, p) => a - p.quantity, 0);
      const archived = await this.lots.reconcileOrphanLots('futures', symbol, {
        longQty,
        shortQty,
      });
      if (archived > 0) {
        this.logger.warn(
          `启动前归档 ${archived} 个孤儿 Lot（交易所持仓 多 ${longQty} / 空 ${shortQty}）`,
        );
      }
    }

    // 接管：把该交易对下「无归属」的未完结 Lot 显式划归本实例。
    // 已归属其他实例的不动——那是别人的篮子。
    const adopted = opts?.adoptExisting
      ? await this.lots.claimUnassigned('futures', symbol, instanceId)
      : 0;

    const blockingLots = await this.getBlockingLots(symbol);
    if (blockingLots.length > 0 && !opts?.adoptExisting) {
      return {
        ok: false,
        status: await this.getStatus(),
        blockingLots,
        message:
          `还有 ${blockingLots.length} 个无归属的仓位单未平仓。` +
          '若这是同一个策略留下的（例如服务重启），可选择「接管并启动」继续管理；' +
          '否则请先在合约面板手动平掉。',
      };
    }
    if (adopted > 0) {
      this.logger.warn(
        `已接管 ${adopted} 个无归属仓位单（instance=${instanceId}），出场将由本策略负责`,
      );
    }

    const params = strategy.normalizeParams(rawParams);

    // 双向持仓是「多空 Lot 共存 + 挂单必须带 positionSide」的交易所前提。
    // 平台不做风控，但这属于「指令能否成立」的硬约束：不满足时挂单会被
    // 交易所以 -4061 全数拒绝，必须阻止启动而不是让策略空转。
    // dry_run 不触交易所，跳过。
    const cfg = await this.futuresConfig.get();
    if (cfg.mode !== 'dry_run') {
      try {
        await this.trading.ensureHedgeMode();
      } catch (err) {
        const detail = (err as Error).message;
        this.logger.error(`双向持仓切换失败，策略未启动：${detail}`);
        return {
          ok: false,
          status: await this.getStatus(),
          message: `双向持仓（hedge mode）切换失败，无法启动策略：${detail}`,
        };
      }
    }

    strategy.onStart?.(params);
    this.instances.set(instanceId, {
      instanceId,
      strategyName: name,
      symbol,
      strategy,
      params,
      startedAt: new Date(),
    });
    this.lastError = null;
    // 运行意图持久化到实例表：重启后按 shouldRun 逐个恢复
    await this.instanceService.markRunning({ strategyName: name, symbol, params });
    this.logger.log(
      `策略实例已启动：${strategy.label} @ ${symbol}（${JSON.stringify(params)}）`,
    );
    return {
      ok: true,
      status: await this.getStatus(),
      message: `策略「${strategy.label}」已启动 @ ${symbol}`,
    };
  }

  /**
   * 停止策略。
   *
   * **不自动平仓**：已有仓位保留在交易所，由用户决定何时了结；
   * 停止只意味着「不再产生新的交易动作」。
   */
  /** 停止全部实例（兼容旧入口） */
  async stop(): Promise<StrategyRunStatus> {
    for (const id of [...this.instances.keys()]) {
      await this.stopInstance(id);
    }
    return this.getStatus();
  }

  /**
   * 停止单个实例。
   *
   * **不自动平仓**：已有仓位保留在交易所，由用户决定何时了结；
   * 停止只意味着「该实例不再产生新的交易动作」。
   * 其他实例不受影响——这正是多实例隔离的意义。
   */
  async stopInstance(instanceId: string): Promise<StrategyRunStatus> {
    const inst = this.instances.get(instanceId);
    if (inst) {
      inst.strategy.onStop?.();
      // 只撤销**本实例**的未成交挂单：挂单是「尚未发生的开仓意图」，
      // 实例停了还留着它，等于策略已下线却仍可能被交易所触发开仓。
      // 其他实例的挂单不动。已成交的持仓**不**动。
      await this.cancelOpenOrdersSafely(inst.symbol, instanceId);
      this.logger.log(
        `策略实例已停止：${inst.strategy.label} @ ${inst.symbol}（持仓保留，需手动处理）`,
      );
      this.instances.delete(instanceId);
    }
    // 清运行意图：停止是用户显式动作，重启后不应自动拉起该实例
    await this.instanceService.markStopped(instanceId);
    return this.getStatus();
  }

  /** 启动后延迟恢复：等待交易所适配器与行情就绪 */
  onModuleInit() {
    const timer = setTimeout(() => {
      void this.resumeIfShould().catch((err) =>
        this.logger.warn(`策略自动恢复失败: ${err.message}`),
      );
    }, 8000);
    if (timer.unref) timer.unref();
  }

  /**
   * 服务启动后自动恢复：按 `strategy_instances` 表逐个恢复 shouldRun 的实例。
   *
   * 兼容：旧单实例意图存在时（`futures_agent_configs.strategyShouldRun`），
   * 先一次性导入到实例表并清掉旧字段——避免老用户升级后策略「消失」。
   */
  private async resumeIfShould(): Promise<void> {
    const legacy = await this.futuresConfig.getRunningIntent();
    if (legacy.shouldRun && legacy.name) {
      const symbol = (await this.futuresConfig.get()).symbol;
      await this.instanceService.markRunning({
        strategyName: legacy.name,
        symbol,
        params: legacy.params,
      });
      await this.futuresConfig.patchRunningIntent({
        shouldRun: false,
        name: null,
        params: null,
      });
      this.logger.log(`已把旧单实例意图迁移到实例表：${legacy.name} @ ${symbol}`);
    }

    const rows = await this.instanceService.listShouldRun();
    for (const row of rows) {
      if (this.instances.has(row.instanceId)) continue;
      const result = await this.startInstance(
        row.strategyName,
        row.symbol,
        row.params ?? undefined,
        { adoptExisting: true },
      );
      if (result.ok) {
        this.logger.log(`服务重启后已自动恢复策略实例：${result.message}`);
      } else {
        this.logger.warn(`实例 ${row.instanceId} 自动恢复未成功：${result.message}`);
      }
    }
  }

  /** 撤销全部未成交挂单；失败只记录，不阻断停止流程 */
  /**
   * 撤销未成交挂单；失败只记录，不阻断调用方流程。
   *
   * 多实例语义：传 `instanceId` 时只撤**该实例**的挂单（其他实例的不动）；
   * 不传则撤全部（运行模式切换等全局场景）。
   */
  private async cancelOpenOrdersSafely(
    symbol?: string,
    instanceId?: string,
  ): Promise<{ canceled: number; failed: number }> {
    try {
      const all = await this.trading.listOpenOrders(symbol);
      const open = instanceId
        ? all.filter((o) => o.strategyInstanceId === instanceId)
        : all;
      if (open.length === 0) return { canceled: 0, failed: 0 };
      let canceled = 0;
      let failed = 0;
      for (const order of open) {
        try {
          await this.trading.cancelOrder(order.id);
          canceled += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(`撤销挂单失败（${order.id}）：${(err as Error).message}`);
        }
      }
      this.logger.log(`已撤销 ${canceled}/${open.length} 张未成交挂单`);
      return { canceled, failed };
    } catch (err) {
      this.logger.warn(`读取未成交挂单失败，跳过撤销：${(err as Error).message}`);
      return { canceled: 0, failed: 0 };
    }
  }

  /**
   * 一键平仓：平掉当前篮子的**全部持仓**，随后策略自动进入下一轮挂单。
   *
   * 与「停止策略」的区别：
   * - 停止 = 不再交易（保留持仓、撤销挂单），仓位变成没人管的状态
   * - 一键平仓 = 了结**当前这一轮**（平掉持仓），策略**继续运行**，
   *   下一 tick 发现篮子空了就会重新挂首层，开启新一轮
   *
   * 用途：手动了结一轮（浮盈满意、想换方向、或想重置节奏），
   * 不必经历「停止 → 再启动 → 选是否接管」这一串操作，也没有空窗期。
   */
  /** 一键平仓：平掉**全部运行实例**的篮子持仓（多实例下逐实例处理） */
  async closeBasket(): Promise<{
    closed: number;
    canceled: number;
    failed: number;
    message: string;
  }> {
    if (this.instances.size === 0) {
      return { closed: 0, canceled: 0, failed: 0, message: '策略未运行，无需平仓' };
    }

    let closed = 0;
    let canceled = 0;
    let failed = 0;
    const notes: string[] = [];

    for (const inst of [...this.instances.values()]) {
      // 先撤本实例挂单：否则平仓的同时挂单仍可能被触发建新仓
      const { canceled: c, failed: cf } = await this.cancelOpenOrdersSafely(
        inst.symbol,
        inst.instanceId,
      );
      canceled += c;
      failed += cf;

      const ctx = await this.buildContextFor(inst);
      if (!ctx) {
        failed += 1;
        continue;
      }
      if (ctx.openLots.length === 0) continue;

      for (const lot of ctx.openLots) {
        const r = await this.executorFor(inst.instanceId).closeLot(lot.id, 'MANUAL');
        if (r.ok) {
          closed += 1;
        } else {
          failed += 1;
          this.logger.warn(`一键平仓失败 lot=${lot.id}: ${r.error}`);
        }
      }
      notes.push(`${inst.symbol} 平 ${ctx.openLots.length} 单`);
    }

    const message =
      failed === 0
        ? `已平掉 ${closed} 个仓位单、撤销 ${canceled} 张挂单，下一轮挂单即将开始`
        : `平掉 ${closed} 单、失败 ${failed} 单（失败的会在下一 tick 重试）`;
    this.logger.log(`一键平仓：${message}（${notes.join('；')}）`);
    return { closed, canceled, failed, message };
  }

  /**
   * 周期性驱动（调度器 5 秒 + 行情事件双触发）。
   *
   * 多实例下**逐实例串行执行**，每个实例独立 try/catch——
   * 单个实例抛异常只记录该实例的错误，不影响其他实例运行。
   */
  async tick(): Promise<void> {
    if (this.instances.size === 0 || this.ticking) return;
    // 节流：行情每帧都推送，但每帧都跑完整策略（含多次 DB 与交易所回查）是浪费。
    // 800ms 已足够跟上 1s 聚合的推送节奏，同时把判定延迟从 5s 压到 1s 以内。
    const nowMs = Date.now();
    if (nowMs - this.lastTickMs < MIN_TICK_INTERVAL_MS) return;
    this.lastTickMs = nowMs;
    this.ticking = true;
    try {
      // 运行模式切换会把已有挂单变成「孤儿」：dry_run 的单不在交易所、
      // 切到真实模式后回查必然失败；反之切到 dry_run 后真实挂单则无人触发。
      // 两种情况下都该先撤掉重挂，这里做一次清理（跨全部实例）。
      const cfg = await this.futuresConfig.get();
      if (this.lastMode !== null && this.lastMode !== cfg.mode) {
        this.logger.warn(`运行模式由 ${this.lastMode} 变为 ${cfg.mode}，撤销旧挂单以避免对账错乱`);
        await this.cancelOpenOrdersSafely();
      }
      this.lastMode = cfg.mode;

      for (const inst of [...this.instances.values()]) {
        try {
          const ctx = await this.buildContextFor(inst);
          if (!ctx) continue;
          await inst.strategy.onTick(ctx, this.executorFor(inst.instanceId));
        } catch (err) {
          // 实例级隔离：单实例失败不影响其他实例
          this.lastError = `实例 ${inst.instanceId}: ${(err as Error).message}`;
          this.logger.error(`策略 tick 失败：${this.lastError}`);
        }
      }
      this.lastTickAt = new Date();
      // 推进配置表的 lastRunAt：总览页的「最后运行」据此展示
      void this.futuresConfig.markRun().catch(() => undefined);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 运行状态（聚合）。
   *
   * 兼容字段（name/label/params/state…）取**第一个实例**——
   * 单实例场景与改造前完全一致；多实例详情走 `instanceCount` 与实例表。
   */
  async getStatus(): Promise<StrategyRunStatus> {
    const first = [...this.instances.values()][0] ?? null;
    const openLots = first
      ? (await this.lots.listOpen('futures', first.symbol)).filter(
          (l) => l.strategyInstanceId === first.instanceId,
        )
      : [];
    // 当前实例的 OPEN 篮子（含层明细）：前端据此展示「哪些订单属于一轮、会被一起平掉」
    const baskets = first
      ? await this.baskets
          .listOpenByInstance(first.instanceId, (sym) => this.market.getTicker(sym)?.price ?? 0)
          .catch(() => [])
      : [];
    return {
      running: this.instances.size > 0,
      name: first?.strategy.name ?? null,
      label: first?.strategy.label ?? null,
      params: first?.params ?? null,
      startedAt: first ? first.startedAt.toISOString() : null,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastError: this.lastError,
      state: first?.strategy.getState() ?? null,
      openLotCount: openLots.length,
      // P2 新增：实例数（前端据此判断是否多实例运行）
      instanceCount: this.instances.size,
      baskets,
    };
  }

  /**
   * 启动拦截：**以交易所实际持仓为准**（本地 Lot 不是事实来源）。
   *
   * 曾以本地 Lot 判断，但用户在交易所手动平仓后本地 Lot 仍是 OPEN——
   * 于是「已经没仓位了」却被永久拦住，策略再也启不来。
   * 本地 Lot 只是订单级归档（绩效归因用），有没有仓位要看交易所。
   */
  private async getBlockingLots(symbol?: string): Promise<BlockingLot[]> {
    const sym = symbol ?? (await this.futuresConfig.get()).symbol;
    const positions = await this.safePositions(sym);
    const held = positions.filter((p) => Math.abs(p.quantity) > 1e-12);
    if (held.length === 0) return [];

    return held.map((p) => ({
      id: p.symbol,
      direction: p.quantity > 0 ? 'LONG' : 'SHORT',
      quantity: Math.abs(p.quantity),
      entryPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
      // 交易所持仓快照不带开仓时间，前端据此显示「—」
      openedAt: '',
    }));
  }

  /** 构造策略上下文：只给事实（价格/ATR/K线/持仓/挂单/保证金），不给任何建议 */
  /**
   * 为单个实例构建上下文。
   *
   * 关键：Lot 与挂单都按 `strategyInstanceId` **严格过滤**——
   * 这是「每个实例只看到自己的仓位」的实现点。
   * 归属其他实例的仓不进 ctx，策略自然不会去加层或平它们。
   */
  private async buildContextFor(inst: {
    instanceId: string;
    symbol: string;
    params: Record<string, unknown>;
  }): Promise<StrategyContext | null> {
    const symbol = inst.symbol;

    const ticker = this.market.getTicker(symbol);
    const price = ticker?.price ?? 0;
    if (!(price > 0)) {
      this.logger.warn(`[${inst.instanceId}] 行情价格不可用，跳过本轮 tick`);
      return null;
    }

    const candles: Candle[] = this.market.getCandles(symbol, '1m', CONTEXT_CANDLE_LIMIT);
    const [openLots, openOrders, availableMargin, positions, pendingCloseLots] =
      await Promise.all([
        this.lots.listOpen('futures', symbol),
        this.trading.listOpenOrders(symbol),
        this.safeAvailableMargin(),
        this.safePositions(symbol),
        // 在途平仓委托：策略据此避免对同一 Lot 重复平仓
        this.trading.listPendingCloseLotIds(symbol),
      ]);
    const pendingCloseSet = new Set(pendingCloseLots);
    // 实例过滤：只保留本实例的仓与单
    const myLots = openLots.filter((l) => l.strategyInstanceId === inst.instanceId);
    const myOrders = openOrders.filter((o) => o.strategyInstanceId === inst.instanceId);

    // 标记价：止盈判定用它（抗插针、与交易所风控同口径），
    // 取不到时退化为 0，策略会回退到最新成交价
    const markPrice =
      positions.find((p) => p.symbol === symbol && p.markPrice > 0)?.markPrice ?? 0;
    const netQty = positions.reduce((acc, p) => acc + p.quantity, 0);

    // 浮盈判定基准：默认标记价；策略参数 triggerPriceType=last 时改用最新成交价
    // （更跟手但可能被插针误触发）。基准同时决定 openLots.unrealizedPnl 与面板净/毛值。
    const triggerBasis =
      (inst.params as { triggerPriceType?: string } | undefined)?.triggerPriceType === 'last'
        ? 'last'
        : 'mark';
    const basisPrice = triggerBasis === 'last' ? price : markPrice > 0 ? markPrice : price;

    return {
      instanceId: inst.instanceId,
      symbol,
      price,
      markPrice,
      atr: this.computeAtr(candles),
      candles,
      openLots: myLots.map((lot): StrategyLotView => {
        // 浮盈按**判定基准价**计：默认标记价（止盈判定不能被单笔插针扭曲），
        // triggerPriceType=last 时用最新成交价。基准取不到标记价时才退回最新成交价。
        const dto = this.lots.toDTO(lot, basisPrice);
        return {
          id: dto.id,
          direction: dto.direction,
          quantity: dto.quantity,
          entryPrice: dto.entryPrice,
          unrealizedPnl: dto.unrealizedPnl ?? 0,
          entryFeeUsdt: dto.entryFeeUsdt ?? 0,
          openedAt: dto.openedAt,
          hasPendingClose: pendingCloseSet.has(dto.id),
        };
      }),
      openOrders: myOrders.map((o) => ({
        id: o.id,
        side: o.side,
        type: o.type,
        stopPrice: Number(o.stopPrice ?? o.price ?? 0),
        quantity: Number(o.quantity ?? 0),
        exchangeOrderId: o.exchangeOrderId ?? null,
      })),
      availableMargin,
      netQty,
      params: inst.params,
      now: Date.now(),
    };
  }

  /**
   * 按实例包装执行器：策略下单时自动带上自己的实例归属，
   * 策略代码完全无感知（契约不变）。
   */
  private executorFor(instanceId: string): StrategyExecutor {
    const ex = this.executor;
    return {
      openLot: (input) => ex.openLot(input, instanceId),
      closeLot: (lotId, reason) => ex.closeLot(lotId, reason, instanceId),
      placeStopOrder: (input) => ex.placeStopOrder(input, instanceId),
      cancelOrder: (orderId) => ex.cancelOrder(orderId),
    };
  }

  /** 持仓快照读取失败不阻塞策略：按无持仓处理，仅影响标记价与净持仓 */
  private async safePositions(symbol: string): Promise<FuturesPositionSnapshot[]> {
    try {
      return await this.positions.listPositions(symbol);
    } catch {
      return [];
    }
  }

  /** 保证金读取失败不阻塞策略：按 0 处理（策略会自行判断能否开仓） */
  private async safeAvailableMargin(): Promise<number> {
    try {
      return await this.trading.getAvailableMargin();
    } catch {
      return 0;
    }
  }

  private computeAtr(candles: Candle[]): number {
    if (candles.length < 20) return 0;
    const v = atr(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      14,
    );
    return Number.isFinite(v) ? v : 0;
  }
}
