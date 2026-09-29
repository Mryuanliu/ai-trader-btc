import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_SYMBOL } from '@ai-trader/shared';
import type { RegisteredTool } from '../../agent/llm-tools';
import { IncomeService } from '../../account/income.service';
import { LotService } from '../../account/lot.service';
import { BasketService } from '../../account/basket.service';
import { OverviewService } from '../../overview/overview.service';
import { FuturesPositionService } from '../../futures/futures-position.service';
import { FuturesTradingService } from '../../futures/futures-trading.service';
import { FuturesConfigService } from '../../futures/futures-config.service';
import { MarketService } from '../../market/market.service';
import { NewsService } from '../../news/news.service';
import { StrategyRunner } from '../../strategy/strategy-runner.service';

/**
 * 交易数据工具层：把行内服务薄映射成 LLM function-calling 工具。
 *
 * 设计约束（与 docs/feishu-llm-bot-plan.md 锁定决策一致）：
 * - 9 个只读工具：全部投影现有服务的权威口径数据，不做二次计算；
 * - 3 个写工具（stop_strategy/start_strategy/close_basket）：这里只定义 schema
 *   与执行方法，**执行权在确认流**（ConfirmationStore 确认后调 executeWrite），
 *   readTools() 注册的写工具 exec 永远返回拦截提示，LLM 循环内不可直接动仓；
 * - 输出控制：列表类默认限量、金额保留 2 位，避免把 token 花在格式上。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 相对周期 → [from, to]（北京时间日历边界，返回 Date 供 income.summary 过滤） */
function resolvePeriod(period: string, from?: string, to?: string): { from: Date; to: Date } | null {
  const now = Date.now();
  const bjNow = new Date(now + BEIJING_OFFSET_MS);
  const dayStartUtcMs = Math.floor(bjNow.getTime() / 86_400_000) * 86_400_000 - BEIJING_OFFSET_MS;
  const monthStartUtcMs =
    Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1) - BEIJING_OFFSET_MS;
  const dayMs = 86_400_000;
  switch (period) {
    case 'today':
      return { from: new Date(dayStartUtcMs), to: new Date(now) };
    case '7d':
      return { from: new Date(now - 7 * dayMs), to: new Date(now) };
    case '30d':
      return { from: new Date(now - 30 * dayMs), to: new Date(now) };
    case 'this_month':
      return { from: new Date(monthStartUtcMs), to: new Date(now) };
    case 'custom': {
      if (!from || !to) return null;
      const f = new Date(from);
      const t = new Date(to);
      if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null;
      return { from: f, to: t };
    }
    default:
      return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class TradingToolsService {
  private readonly logger = new Logger(TradingToolsService.name);

  constructor(
    private readonly income: IncomeService,
    private readonly lots: LotService,
    private readonly baskets: BasketService,
    private readonly overview: OverviewService,
    private readonly futuresPositions: FuturesPositionService,
    private readonly futuresTrading: FuturesTradingService,
    private readonly futuresConfig: FuturesConfigService,
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly runner: StrategyRunner,
    private readonly config: ConfigService,
  ) {}

  /** 只读工具 + 写工具 schema（写工具 exec 是安全桩，真正执行走 executeWrite） */
  readTools(): RegisteredTool[] {
    return [
      {
        def: {
          name: 'get_pnl_summary',
          description:
            '区间已实现盈亏/手续费/资金费汇总（交易所 income 权威口径）。period: today|7d|30d|this_month|custom（custom 需 from/to ISO 日期）。',
          parameters: {
            type: 'object',
            properties: {
              period: { type: 'string', enum: ['today', '7d', '30d', 'this_month', 'custom'] },
              from: { type: 'string', description: 'custom 时必填，ISO 日期' },
              to: { type: 'string', description: 'custom 时必填，ISO 日期' },
              symbol: { type: 'string', description: '可选，如 BTCUSDT；缺省全市场' },
            },
            required: ['period'],
          },
        },
        exec: async (args) => {
          const range = resolvePeriod(String(args.period ?? ''), args.from as string, args.to as string);
          if (!range) return { error: 'bad_period', detail: 'period 非法或 custom 缺 from/to' };
          const s = await this.income.summary({ symbol: args.symbol as string | undefined, from: range.from, to: range.to });
          return {
            range: { from: range.from.toISOString(), to: range.to.toISOString() },
            realizedPnl: round2(s.realizedPnl),
            realizedCount: s.realizedCount,
            commission: round2(s.commission),
            fundingFee: round2(s.fundingFee),
            other: round2(s.other),
            net: round2(s.net),
            rows: s.count,
            note:
              s.realizedCount === 0
                ? '该环境 income 流水不含 REALIZED_PNL（demo 特性），realized 请配合 get_daily_pnl 的平台口径查看'
                : '交易所权威口径',
          };
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'get_daily_pnl',
          description: '近 N 天逐日已实现盈亏（平台记账净口径，Asia/Shanghai 自然日）。',
          parameters: {
            type: 'object',
            properties: { days: { type: 'number', description: '1~90，默认 7' } },
          },
        },
        exec: async (args) => {
          const days = Math.min(90, Math.max(1, Number(args.days ?? 7)));
          const rows = await this.lots.realizedPnlByDay(days);
          return rows.map((r) => ({ date: r.date, realizedPnl: round2(r.realizedPnl), trades: r.trades }));
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'get_account_overview',
          description: '账户总览：余额、可用保证金、持仓与盈亏汇总（默认 BTCUSDT）。',
          parameters: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
          },
        },
        exec: async (args) => {
          const dto = await this.overview.build((args.symbol as string) ?? DEFAULT_SYMBOL);
          return dto;
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'list_open_positions',
          description: '当前交易所净持仓（含标记价、最新价、强平价、杠杆、浮动盈亏）。',
          parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
        },
        exec: async (args) => {
          const rows = await this.futuresPositions.listPositions(args.symbol as string | undefined);
          return rows.map((p) => {
            const ticker = this.market.getTicker(p.symbol);
            return {
              symbol: p.symbol,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              lastPrice: ticker?.lastPrice ?? ticker?.price ?? null,
              unrealizedPnl: round2(p.unrealizedPnl),
              leverage: p.leverage,
              liquidationPrice: p.liquidationPrice,
            };
          });
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'list_recent_baskets',
          description: '近期篮子（一轮建仓→了结）：整体盈亏为净口径（已扣双边手续费），含浮动部分。',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: '1~50，默认 10' } },
          },
        },
        exec: async (args) => {
          const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
          const rows = await this.baskets.listRecent(limit, 'futures', (sym) => this.market.getTicker(sym)?.price ?? 0);
          return rows.map((b) => ({
            code: b.code,
            symbol: b.symbol,
            direction: b.direction,
            status: b.status,
            layerCount: b.layerCount,
            avgEntryPrice: b.avgEntryPrice,
            realizedPnl: round2(b.realizedPnl),
            returnPct: b.returnPct === null || b.returnPct === undefined ? null : round2(b.returnPct),
          }));
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'list_recent_orders',
          description: '近期合约订单（含状态/成交均价/来源策略）。',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: '1~100，默认 20' } },
          },
        },
        exec: async (args) => {
          const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
          const rows = await this.futuresTrading.list({ limit });
          return rows.map((o) => ({
            symbol: o.symbol,
            side: o.side,
            type: o.type,
            status: o.status,
            price: o.price,
            filledPrice: o.filledPrice,
            quantity: o.quantity,
            filledQuantity: o.filledQuantity,
            source: o.source,
            mode: o.mode,
            createdAt: o.createdAt,
          }));
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'get_market_price',
          description: '行情快照：最新成交价/盘口中间价/标记价/24h 涨跌与波动。',
          parameters: {
            type: 'object',
            properties: { symbol: { type: 'string', description: '默认 BTCUSDT' } },
          },
        },
        exec: async (args) => {
          const symbol = (args.symbol as string) ?? DEFAULT_SYMBOL;
          const pulse = this.market.getMarketPulse(symbol);
          const ticker = this.market.getTicker(symbol);
          return {
            symbol,
            lastPrice: ticker?.lastPrice ?? ticker?.price ?? null,
            bookMidPrice: ticker?.price ?? null,
            changePercent24h: pulse?.changePercent24h ?? null,
            high24h: pulse?.high24h ?? null,
            low24h: pulse?.low24h ?? null,
            volatility24h: pulse?.volatility24h ?? null,
          };
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'get_strategy_status',
          description: '策略运行状态：是否运行、实例数、当前参数、最近 tick、未完结仓位单数、运行意图。',
          parameters: { type: 'object', properties: {} },
        },
        exec: async () => {
          const status = await this.runner.getStatus();
          const intent = await this.futuresConfig.getRunningIntent().catch(() => null);
          return {
            running: status.running,
            name: status.name,
            label: status.label,
            instanceCount: status.instanceCount ?? (status.running ? 1 : 0),
            startedAt: status.startedAt,
            lastTickAt: status.lastTickAt,
            lastError: status.lastError,
            openLotCount: status.openLotCount,
            runningIntent: intent,
            environment: this.config.get<string>('BINANCE_ENV', 'demo'),
          };
        },
        source: 'builtin',
      },
      {
        def: {
          name: 'get_news_latest',
          description: '最新快讯条目（标题/来源/时间）。',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: '1~20，默认 8' } },
          },
        },
        exec: async (args) => {
          const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)));
          return this.news.getRecent(limit);
        },
        source: 'builtin',
      },
      // ── 写工具 schema：exec 是安全桩，真实执行只经 executeWrite（确认流调用） ──
      this.writeToolStub('stop_strategy', '停止策略实例（不自动平仓）。instanceId 形如 martingale-grid:BTCUSDT，缺省停止全部。', {
        type: 'object',
        properties: { instanceId: { type: 'string' } },
      }),
      this.writeToolStub('start_strategy', '启动策略（使用平台当前配置的默认策略与交易对；已有未完结仓位时需用户明确接管）。', {
        type: 'object',
        properties: {
          name: { type: 'string', description: '缺省用运行意图里的策略名' },
          symbol: { type: 'string', description: '缺省用平台配置交易对' },
        },
      }),
      this.writeToolStub('close_basket', '一键平掉当前运行策略的 OPEN 篮子（真实平仓，会产生交易所单）。', {
        type: 'object',
        properties: {},
      }),
    ];
  }

  private writeToolStub(name: string, description: string, parameters: Record<string, unknown>): RegisteredTool {
    return {
      def: { name, description, parameters },
      exec: async () => {
        // 兜底：若未经 shouldIntercept 直接执行到桩，绝不落地副作用
        return { error: 'blocked', detail: '该操作需用户在飞书群回复确认后执行' };
      },
      write: true,
      source: 'builtin',
    };
  }

  /** 确认流专用执行入口：只有 ConfirmationStore 在用户回「确认」后调用 */
  async executeWrite(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (name === 'stop_strategy') {
        const instanceId = args.instanceId ? String(args.instanceId) : null;
        if (!instanceId) {
          const status = await this.runner.stop();
          return `已停止全部策略实例（持仓保留）。running=${status.running}`;
        }
        const status = await this.runner.stopInstance(instanceId);
        return `已停止实例「${instanceId}」（持仓保留）。running=${status.running}`;
      }
      if (name === 'start_strategy') {
        const cfg = await this.futuresConfig.get();
        const intent = await this.futuresConfig.getRunningIntent().catch(() => null);
        const symbol = String(args.symbol ?? cfg.symbol ?? DEFAULT_SYMBOL);
        const strategyName = String(args.name ?? intent?.name ?? '');
        if (!strategyName) {
          const available = this.runner.list().map((d) => d.name).join(', ');
          return `启动失败：未提供策略名且平台无运行意图。可用策略：${available || '（无）'}`;
        }
        const res = await this.runner.startInstance(strategyName, symbol, undefined, { adoptExisting: false });
        return res.ok
          ? `已启动「${strategyName} @ ${symbol}」`
          : `启动被拒绝：${res.message ?? '未知原因'}（如提示存在未完结仓位，需要用户决策后重试并明确接管）`;
      }
      if (name === 'close_basket') {
        const res = await this.runner.closeBasket();
        return `平仓指令完成：平掉 ${res.closed} 层，撤单 ${res.canceled} 笔，失败 ${res.failed} 笔。${res.message ?? ''}`;
      }
      return `未知写操作：${name}`;
    } catch (err) {
      this.logger.warn(`写工具 ${name} 执行失败：${(err as Error).message}`);
      return `执行失败：${(err as Error).message}`;
    }
  }
}
