#!/usr/bin/env node
/**
 * 交易档案分析 CLI（2026-10-17 实测调优回路）。
 *
 * 用法：
 *   pnpm --filter @ai-trader/server analyze:trades -- --day 2026-10-17 [--instance martingale_grid_v2:BTCUSDT]
 *
 * 数据源：logs/trade-records/<slug>/events-<day>.jsonl（策略/档案事件）
 *        + DB（position_lots 开仓费/实际成交、exchange_incomes 资金费、market_candles 1m 审计、orders FAILED）。
 * 输出：reports/fieldrun/<day>-<slug>-report.md + .json。
 *
 * 纯聚合逻辑在 src/analysis/trade-analyzer.ts（可单测）；本文件只负责
 * 「读盘 → 加载 DB → 调 analyze → 渲染落盘」。沿用历史数据 CLI 的
 * dotenv-import-first + 动态 import data-source 约定（.env 必须先于 DataSource 构造）。
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { promises as fs } from 'node:fs';

// .env 多路径兜底（脚本可能从 apps/server 或仓库根运行）
for (const p of [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]) {
  dotenv.config({ path: p });
}

// 静态引入零副作用的纯函数/实体类型（data-source 在 main 里动态 import）
import { PositionLotEntity } from '../database/entities/position-lot.entity';
import { ExchangeIncomeEntity } from '../database/entities/exchange-income.entity';
import { MarketCandleEntity } from '../database/entities/market-candle.entity';
import { OrderEntity } from '../database/entities/order.entity';
import {
  analyze,
  parseJsonl,
  type AnalyzeInput,
  type AnalyzeReport,
  type EventRow,
  type OpenLotInfo,
  type CandleRow,
  type FundingIncome,
  type FailOrderInfo,
} from '../analysis/trade-analyzer';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/** 上海时区日历日 → UTC 毫秒窗 [start,end) */
function shanghaiDayRange(day: string): { start: number; end: number } {
  // 2026-10-17 00:00:00 +08 = 2026-10-16T16:00:00Z
  const start = Date.parse(`${day}T00:00:00+08:00`);
  return { start, end: start + 86_400_000 };
}

function slugOf(instanceId: string): string {
  if (instanceId === '-') return '_platform';
  return instanceId.replace(/[^A-Za-z0-9:_-]/g, '_').replace(/:/g, '-');
}

async function loadEvents(recDir: string, slug: string, day: string): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (const s of [slug, '_platform']) {
    const file = path.join(recDir, s, `events-${day}.jsonl`);
    try {
      rows.push(...parseJsonl(await fs.readFile(file, 'utf8')));
    } catch {
      // 文件不存在 = 当日该 slug 无事件（平台/策略之一），正常
    }
  }
  rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const day = args.day;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('用法：pnpm --filter @ai-trader/server analyze:trades -- --day YYYY-MM-DD [--instance name:SYMBOL]');
    process.exit(1);
  }
  const instance = args.instance ?? 'martingale_grid_v2:BTCUSDT';
  const [instName, symbol] = instance.split(':');
  const { start, end } = shanghaiDayRange(day);
  const recDir = process.env.TRADE_RECORD_DIR || 'logs/trade-records';

  const events = await loadEvents(recDir, slugOf(instance), day);
  if (events.length === 0) {
    console.error(`未找到事件文件：${recDir}/${slugOf(instance)}/events-${day}.jsonl（当日无档案？）`);
    process.exit(1);
  }
  console.log(`载入事件 ${events.length} 行（${instance} @ ${day}）`);

  // data-source 动态 import：确保 dotenv 已生效
  const { AppDataSource } = await import('../database/data-source');
  await AppDataSource.initialize();

  try {
    // ---- DB 富化 ----
    const lotRepo = AppDataSource.getRepository(PositionLotEntity);
    const lots = await lotRepo.find({
      where: { market: 'futures', symbol, strategyInstanceId: instance },
      order: { openedAt: 'ASC' },
    });
    // 只保留生命周期与本窗有交集的 Lot
    const inWindow = lots.filter(
      (l) => l.openedAt.getTime() >= start - 86_400_000 && (l.closedAt?.getTime() ?? end) <= end + 86_400_000,
    );
    // 篮子 code 关联（LOT_SETTLE 事件带 basketCode，但开仓费/时长以 DB 权威）
    const basketIds = inWindow.map((l) => l.basketId).filter((x): x is string => Boolean(x));
    const { BasketEntity } = await import('../database/entities/basket.entity');
    const baskets = basketIds.length
      ? await AppDataSource.getRepository(BasketEntity).find({ where: basketIds.map((id) => ({ id })) })
      : [];
    const codeById = new Map(baskets.map((b) => [b.id, b.code]));

    const openLots: OpenLotInfo[] = inWindow.map((l) => ({
      id: l.id,
      basketCode: l.basketId ? codeById.get(l.basketId) ?? null : null,
      direction: l.direction,
      quantity: Number(l.quantity),
      entryPrice: Number(l.entryPrice),
      entryFee: Number(l.entryFeeUsdt),
      openedAt: l.openedAt.getTime(),
      closedAt: l.closedAt ? l.closedAt.getTime() : null,
      exitPrice: l.exitPrice === null ? null : Number(l.exitPrice),
      exitFee: l.exitFeeUsdt === null ? null : Number(l.exitFeeUsdt),
      exitReason: l.exitReason,
      realizedPnl: l.realizedPnl === null ? null : Number(l.realizedPnl),
    }));

    const incomeRepo = AppDataSource.getRepository(ExchangeIncomeEntity);
    const incomeRows = await incomeRepo
      .createQueryBuilder('i')
      .where("i.incomeType = 'FUNDING_FEE'")
      .andWhere('i.symbol = :sym', { sym: symbol })
      .andWhere('i.time BETWEEN :a AND :b', { a: new Date(start), b: new Date(end) })
      .getMany();
    const funding: FundingIncome[] = incomeRows.map((r) => ({ time: r.time.getTime(), amount: Number(r.amount) }));

    const candleRepo = AppDataSource.getRepository(MarketCandleEntity);
    const candleRows = await candleRepo
      .createQueryBuilder('c')
      .where("c.interval = '1m'")
      .andWhere('c.symbol = :sym', { sym: symbol })
      .andWhere('c.market = :mkt', { mkt: 'futures' })
      .andWhere('c.openTime BETWEEN :a AND :b', { a: start, b: end })
      .orderBy('c.openTime', 'ASC')
      .getMany();
    const candles: CandleRow[] = candleRows.map((c) => ({
      openTime: Number(c.openTime),
      high: c.high,
      low: c.low,
    }));

    const orderRepo = AppDataSource.getRepository(OrderEntity);
    const failRows = await orderRepo
      .createQueryBuilder('o')
      .where("o.status = 'FAILED'")
      .andWhere('o.symbol = :sym', { sym: symbol })
      .andWhere('o.strategyInstanceId = :inst', { inst: instance })
      .andWhere('o.createdAt BETWEEN :a AND :b', { a: new Date(start), b: new Date(end) })
      .getMany();
    const failedOrders: FailOrderInfo[] = failRows.map((o) => ({
      orderId: o.id,
      lotId: o.lotId,
      error: o.error,
    }));

    // TP 阈值（费用占比对照用）：从事件里最新 EXIT_TRACE 的 rules.tpUsdt.thr 回推
    const lastTp = [...events].reverse().find((e) => e.type === 'EXIT_TRACE' && e.rules);
    const tpThrUsdt = Number(
      ((lastTp?.rules as Record<string, unknown> | undefined)?.tpUsdt as { thr?: number } | undefined)?.thr ?? 0,
    ) || undefined;

    const input: AnalyzeInput = {
      events,
      openLots,
      funding,
      candles,
      failedOrders,
      tpThrUsdt,
    };
    const report = analyze(input);
    report.meta.day = day;
    report.meta.inst = instance;

    // ---- 落盘 ----
    const outDir = path.resolve('reports', 'fieldrun');
    await fs.mkdir(outDir, { recursive: true });
    const base = `${day}-${slugOf(instance)}`;
    await fs.writeFile(path.join(outDir, `${base}.json`), JSON.stringify(report, null, 2), 'utf8');
    const md = renderMarkdown(report);
    const mdPath = path.join(outDir, `${base}-report.md`);
    await fs.writeFile(mdPath, md, 'utf8');

    console.log(md);
    console.log(`\n报告已写入：${mdPath}\n        JSON：${path.join(outDir, `${base}.json`)}`);
  } finally {
    await AppDataSource.destroy();
  }
}

// ------------------------------------------------------------------ Markdown 渲染

function pct(v: number, dp = 1): string {
  return `${(v * 100).toFixed(dp)}%`;
}

function renderMarkdown(r: AnalyzeReport): string {
  const L: string[] = [];
  L.push(`# 马丁网格 V2 实测档案报告 · ${r.meta.day}`);
  L.push('');
  L.push(`实例 **${r.meta.inst}** | 事件 ${r.meta.events} · EXIT_TRACE ${r.meta.exitTrace} · ENTRY_TRACE ${r.meta.entryTrace} · 结算 ${r.meta.settles} · 篮子 ${r.meta.baskets}`);
  L.push(`_生成于 ${r.meta.generatedAt}_`);
  L.push('');

  L.push('## 1. 篮子/轮次清单');
  L.push('');
  L.push(`- 层数分布：最大 ${r.layers.max} 层 → ${Object.entries(r.layers.histogram).map(([k, v]) => `${k}层×${v}`).join('，') || '无'}`);
  L.push(`- 轮次：止盈 ${r.rounds.tp} / 止损 ${r.rounds.sl} / 其他 ${r.rounds.other}；已了结合计净盈亏 ${r.rounds.pnlSum.toFixed(2)}U`);
  L.push('');
  L.push('| 篮子 | 层数 | 出场 | 净盈亏 | 费(实际) | F(估) | 持仓时长 | 滑点(bps) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const d of r.rounds.detail) {
    const hold = d.holdMs != null ? `${(d.holdMs / 1000).toFixed(0)}s` : '-';
    const slip = d.slippage ? d.slippage.avgAbsBp.toFixed(1) : '-';
    L.push(
      `| ${d.code} | ${d.layerCount ?? '-'} | ${d.exitReason ?? '-'} | ${(d.realizedPnl ?? 0).toFixed(2)} | ${d.feeActual.toFixed(2)} | ${d.fundingEst.toFixed(2)} | ${hold} | ${slip} |`,
    );
  }
  L.push('');

  L.push('## 2. 基差与阈值差分解（面板价已达 TP/SL 但未触发）');
  L.push('');
  if (r.basisEvents.length === 0) {
    L.push('本窗内无「判定价已越线但 mark 口径未越线」的 EXIT_TRACE 事件。');
  } else {
    L.push(`共 ${r.basisEvents.length} 条。四类差距的**首因归类**占比：`);
    L.push('');
    const headTotal = Object.values(r.gapAgg.headCounts).reduce((a, b) => a + b, 0) || 1;
    for (const [k, v] of Object.entries(r.gapAgg.headCounts).sort((a, b) => b[1] - a[1])) {
      L.push(`- ${k}：${v} 条（${pct(v / headTotal, 0)}）`);
    }
    L.push('');
    L.push('| 时间 | 规则 | 差距U | 基差 | 平仓费 | 未arm | 未回撤 | 退避/冷却 | 首因 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const b of r.basisEvents.slice(0, 40)) {
      const d = b.decomp;
      L.push(
        `| ${b.time.slice(11)} | ${b.rule} | ${b.gapUsdt.toFixed(1)} | ${d.basis.toFixed(1)} | ${d.exitFee.toFixed(1)} | ${d.trailNotArmed.toFixed(1)} | ${d.trailNoRetrace.toFixed(1)} | ${d.backoffOrCooldown.toFixed(1)} | ${b.headClass} |`,
      );
    }
  }
  L.push('');

  L.push('## 3. 出场未触发审计（1m K 线对照）');
  L.push('');
  L.push(`notExit 计数：${Object.entries(r.notExitCounts).map(([k, v]) => `${k}×${v}`).join('，') || '无'}`);
  L.push('');
  if (r.audit.length === 0) {
    L.push('无可用的 1m K 线窗（未导历史或该窗无数据），审计跳过。');
  } else {
    for (const a of r.audit) L.push(`- ${a.time} — ${a.note}`);
  }
  L.push('');

  L.push('## 4. 滑点与费用');
  L.push('');
  L.push(`- 滑点（判定价 vs 实际成交均价，绝对 bps）：样本 ${r.slippage.n}，均值 ${r.slippage.avgAbsBp.toFixed(1)}，p90 ${r.slippage.p90AbsBp.toFixed(1)}，最大 ${r.slippage.maxAbsBp.toFixed(1)}`);
  L.push(`- 手续费：开 ${r.fees.entryTotal.toFixed(2)}U + 平 ${r.fees.exitTotal.toFixed(2)}U，占名义 ${pct(r.fees.feePerNotionalPct / 100, 3)}${r.fees.vsTpThrPct != null ? `，相当于单个 TP 阈值的 ${r.fees.vsTpThrPct.toFixed(0)}%` : ''}`);
  L.push(`- 资金费：交易所流水合计 ${r.funding.incomeSum.toFixed(2)}U，按名义×时长摊派估算合计 ${r.funding.allocatedEst.toFixed(2)}U`);
  L.push('');

  L.push('## 5. 废单/失败/对账（验证 P0 修复在环效果）');
  L.push('');
  L.push(`- FAILED 订单 ${r.failures.orderFail} 张；出场撤单失败 ${r.failures.cancelFail}；在途退避 ${r.failures.inflightBackoff}`);
  const errEntries = Object.entries(r.failures.errors);
  if (errEntries.length) {
    L.push('- 错误码分布：' + errEntries.map(([k, v]) => `${k}×${v}`).join('，'));
  }
  L.push('');

  return L.join('\n');
}

void main().catch((err) => {
  console.error('分析失败：', err);
  process.exit(1);
});
