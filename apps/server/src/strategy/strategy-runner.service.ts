import { Injectable, Logger } from '@nestjs/common';
import { atr } from '@ai-trader/shared';
import type { BlockingLot, Candle, StrategyStartResult } from '@ai-trader/shared';
import { MarketService } from '../market/market.service';
import { FuturesConfigService } from '../futures/futures-config.service';
import { FuturesTradingService } from '../futures/futures-trading.service';
import { FuturesPositionService } from '../futures/futures-position.service';
import { LotService } from '../account/lot.service';
import { StrategyRegistry } from './strategy-registry.service';
import { StrategyExecutorService } from './strategy-executor.service';
import type {
  StrategyContext,
  StrategyDescriptor,
  StrategyLotView,
  StrategyRunStatus,
  TradingStrategy,
} from './types';

/** tick 上下文使用的 K 线根数：够算 ATR14 与 30 周期均线并留余量 */
const CONTEXT_CANDLE_LIMIT = 150;

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
export class StrategyRunner {
  private readonly logger = new Logger(StrategyRunner.name);

  private current: {
    strategy: TradingStrategy;
    params: Record<string, unknown>;
    startedAt: Date;
  } | null = null;

  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  /** tick 重入保护：上一次还没跑完就跳过本轮 */
  private ticking = false;
  /** 上一次 tick 时的运行模式：变化时撤销旧挂单（见 tick 内注释） */
  private lastMode: string | null = null;

  constructor(
    private readonly registry: StrategyRegistry,
    private readonly executor: StrategyExecutorService,
    private readonly market: MarketService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly trading: FuturesTradingService,
    private readonly positions: FuturesPositionService,
    private readonly lots: LotService,
  ) {}

  isRunning(): boolean {
    return this.current !== null;
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
  async start(
    name: string,
    rawParams?: Record<string, unknown>,
    opts?: { adoptExisting?: boolean },
  ): Promise<StrategyStartResult> {
    if (this.current) {
      return {
        ok: false,
        status: await this.getStatus(),
        message: `策略「${this.current.strategy.label}」正在运行，请先停止它`,
      };
    }

    const strategy = this.registry.get(name);
    if (!strategy) {
      return { ok: false, status: await this.getStatus(), message: `未知策略：${name}` };
    }

    const blockingLots = await this.getBlockingLots();
    if (blockingLots.length > 0 && !opts?.adoptExisting) {
      return {
        ok: false,
        status: await this.getStatus(),
        blockingLots,
        message:
          `还有 ${blockingLots.length} 个仓位单未平仓。` +
          '若这是同一个策略留下的（例如服务重启），可选择「接管并启动」继续管理；' +
          '否则请先在合约面板手动平掉。',
      };
    }
    if (blockingLots.length > 0) {
      this.logger.warn(
        `接管已有仓位启动（${blockingLots.length} 个未完结仓位单），出场将由本策略负责`,
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
    this.current = { strategy, params, startedAt: new Date() };
    this.lastError = null;
    this.logger.log(`策略已启动：${strategy.label}（${JSON.stringify(params)}）`);
    return {
      ok: true,
      status: await this.getStatus(),
      message: `策略「${strategy.label}」已启动`,
    };
  }

  /**
   * 停止策略。
   *
   * **不自动平仓**：已有仓位保留在交易所，由用户决定何时了结；
   * 停止只意味着「不再产生新的交易动作」。
   */
  async stop(): Promise<StrategyRunStatus> {
    if (this.current) {
      this.current.strategy.onStop?.();
      // 撤销未成交挂单：挂单是「尚未发生的开仓意图」，策略都停了还留着它，
      // 等于策略已下线却仍可能被交易所触发开仓，之后没人管。
      // 已成交的持仓**不**动——那是用户自己的仓位，由用户决定何时了结。
      await this.cancelOpenOrdersSafely();
      this.logger.log(
        `策略已停止：${this.current.strategy.label}（持仓保留，需手动处理；未成交挂单已撤销）`,
      );
      this.current = null;
    }
    return this.getStatus();
  }

  /** 撤销全部未成交挂单；失败只记录，不阻断停止流程 */
  private async cancelOpenOrdersSafely(): Promise<void> {
    try {
      const open = await this.trading.listOpenOrders();
      if (open.length === 0) return;
      let ok = 0;
      for (const order of open) {
        try {
          await this.trading.cancelOrder(order.id);
          ok += 1;
        } catch (err) {
          this.logger.warn(`撤销挂单失败（${order.id}）：${(err as Error).message}`);
        }
      }
      this.logger.log(`已撤销 ${ok}/${open.length} 张未成交挂单`);
    } catch (err) {
      this.logger.warn(`读取未成交挂单失败，跳过撤销：${(err as Error).message}`);
    }
  }

  /** 周期性驱动（由调度器每 5 秒调用） */
  async tick(): Promise<void> {
    if (!this.current || this.ticking) return;
    this.ticking = true;
    const active = this.current;
    try {
      const ctx = await this.buildContext(active.params);
      if (!ctx) return;

      // 运行模式切换会把已有挂单变成「孤儿」：dry_run 的单不在交易所、
      // 切到真实模式后回查必然失败；反之切到 dry_run 后真实挂单则无人触发。
      // 两种情况下都该先撤掉重挂，这里做一次清理。
      const cfg = await this.futuresConfig.get();
      if (this.lastMode !== null && this.lastMode !== cfg.mode) {
        this.logger.warn(`运行模式由 ${this.lastMode} 变为 ${cfg.mode}，撤销旧挂单以避免对账错乱`);
        await this.cancelOpenOrdersSafely();
      }
      this.lastMode = cfg.mode;

      await active.strategy.onTick(ctx, this.executor);
      this.lastTickAt = new Date();
      this.lastError = null;
      // 推进配置表的 lastRunAt：总览页的「最后运行」据此展示，
      // 不更新的话会永远停在旧决策引擎的时间点上
      void this.futuresConfig.markRun().catch(() => undefined);
    } catch (err) {
      this.lastError = (err as Error).message;
      // 策略抛异常只记录并跳过本轮：单次失败不应让整个运行器停摆
      this.logger.error(`策略 tick 失败：${this.lastError}`);
    } finally {
      this.ticking = false;
    }
  }

  async getStatus(): Promise<StrategyRunStatus> {
    const openLots = await this.lots.listOpen(
      'futures',
      (await this.futuresConfig.get()).symbol,
    );
    return {
      running: this.current !== null,
      name: this.current?.strategy.name ?? null,
      label: this.current?.strategy.label ?? null,
      params: this.current?.params ?? null,
      startedAt: this.current ? this.current.startedAt.toISOString() : null,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastError: this.lastError,
      state: this.current?.strategy.getState() ?? null,
      openLotCount: openLots.length,
    };
  }

  /** 未完结仓位单（启动拦截用）：排除正在运行策略自己建的仓 */
  private async getBlockingLots(): Promise<BlockingLot[]> {
    const symbol = (await this.futuresConfig.get()).symbol;
    const lots = await this.lots.listOpen('futures', symbol);
    if (lots.length === 0) return [];

    let price = 0;
    try {
      price = this.market.getTicker(symbol).price;
    } catch {
      price = 0;
    }
    return lots.map((lot) => {
      const dto = this.lots.toDTO(lot, price);
      return {
        id: dto.id,
        direction: dto.direction,
        quantity: dto.quantity,
        entryPrice: dto.entryPrice,
        unrealizedPnl: dto.unrealizedPnl ?? 0,
        openedAt: dto.openedAt,
      };
    });
  }

  /** 构造策略上下文：只给事实（价格/ATR/K线/持仓/挂单/保证金），不给任何建议 */
  private async buildContext(params: Record<string, unknown>): Promise<StrategyContext | null> {
    const cfg = await this.futuresConfig.get();
    const symbol = cfg.symbol;

    const ticker = this.market.getTicker(symbol);
    const price = ticker?.price ?? 0;
    if (!(price > 0)) {
      this.logger.warn('行情价格不可用，跳过本轮 tick');
      return null;
    }

    const candles: Candle[] = this.market.getCandles(symbol, '1m', CONTEXT_CANDLE_LIMIT);
    const [openLots, openOrders, availableMargin, netQty, pendingCloseLots] = await Promise.all([
      this.lots.listOpen('futures', symbol),
      this.trading.listOpenOrders(symbol),
      this.safeAvailableMargin(),
      this.positions.getNetQuantity(symbol),
      // 在途平仓委托：策略据此避免对同一 Lot 重复平仓
      this.trading.listPendingCloseLotIds(symbol),
    ]);
    const pendingCloseSet = new Set(pendingCloseLots);

    return {
      symbol,
      price,
      atr: this.computeAtr(candles),
      candles,
      openLots: openLots.map((lot): StrategyLotView => {
        const dto = this.lots.toDTO(lot, price);
        return {
          id: dto.id,
          direction: dto.direction,
          quantity: dto.quantity,
          entryPrice: dto.entryPrice,
          unrealizedPnl: dto.unrealizedPnl ?? 0,
          openedAt: dto.openedAt,
          hasPendingClose: pendingCloseSet.has(dto.id),
        };
      }),
      openOrders: openOrders.map((o) => ({
        id: o.id,
        side: o.side,
        type: o.type,
        stopPrice: Number(o.stopPrice ?? o.price ?? 0),
        quantity: Number(o.quantity ?? 0),
        exchangeOrderId: o.exchangeOrderId ?? null,
      })),
      availableMargin,
      netQty,
      params,
      now: Date.now(),
    };
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
