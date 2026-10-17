/**
 * 交易档案分析器（纯函数层，2026-10-17 实测调优回路）。
 *
 * 输入 = events jsonl 解析后的行 + DB 富化数据（调用方加载后注入），
 * 输出 = 结构化分析报告对象（md/json 渲染在 CLI）。纯函数不碰 FS/DB，
 * 单测可以直接喂构造事件验证差分解放等逻辑。
 *
 * 核心问题（用户实锤场景）：「面板价已达止盈但没触发」——每条这类事件
 * 都要能拆成四段差：mark-vs-last 基差 / 预估平仓费扣减 / 追踪未 arm 或未回撤 /
 * 在途退避·冷却闸，并给出量化占比。
 */

export interface EventRow {
  ts: number;
  time: string;
  inst: string;
  type: string;
  [k: string]: unknown;
}

export interface OpenLotInfo {
  id: string;
  basketCode: string | null;
  direction: string;
  quantity: number;
  entryPrice: number;
  entryFee: number;
  openedAt: number;
  closedAt: number | null;
  exitPrice: number | null;
  exitFee: number | null;
  exitReason: string | null;
  realizedPnl: number | null;
}

export interface FundingIncome {
  time: number;
  amount: number;
}

export interface CandleRow {
  openTime: number;
  high: number;
  low: number;
}

export interface FailOrderInfo {
  orderId: string;
  lotId: string | null;
  error: string | null;
}

export interface AnalyzeInput {
  events: EventRow[];
  /** 时间窗内本实例的 Lot 全量（含未平）：开仓费/持仓时长/实际成交价的权威源 */
  openLots: OpenLotInfo[];
  funding: FundingIncome[];
  /** 判定窗口后的 1m K 线：审计「该触发没触发」 */
  candles: CandleRow[];
  failedOrders: FailOrderInfo[];
  tpThrUsdt?: number;
}

export interface GapDecomposition {
  total: number;
  basis: number;
  exitFee: number;
  trailNotArmed: number;
  trailNoRetrace: number;
  backoffOrCooldown: number;
  unattributed: number;
}

type Bucket = keyof Omit<GapDecomposition, 'total'>;

export interface BasisEvent {
  ts: number;
  time: string;
  rule: 'TP' | 'SL';
  direction: 'LONG' | 'SHORT';
  netAtLast: number;
  net: number;
  thr: number;
  gapUsdt: number;
  gapPct: number;
  decomp: GapDecomposition;
  headClass: Bucket | 'NONE';
}

export interface BasketSummary {
  code: string;
  layerCount: number | null;
  realizedPnl: number | null;
  feeTotal: number | null;
  exitReason: string | null;
  holdMs: number | null;
  notional: number;
  feeActual: number;
  fundingEst: number;
  slippage: { n: number; avgAbsBp: number; maxAbsBp: number } | null;
  decision: { exit: string | null; notExitLast: string | null };
}

export interface AnalyzeReport {
  meta: {
    day: string;
    inst: string;
    events: number;
    exitTrace: number;
    entryTrace: number;
    settles: number;
    baskets: number;
    generatedAt: string;
  };
  layers: { max: number; histogram: Record<number, number> };
  rounds: { tp: number; sl: number; other: number; pnlSum: number; detail: BasketSummary[] };
  basisEvents: BasisEvent[];
  gapAgg: {
    counts: Record<string, number>;
    sumUsdt: Record<string, number>;
    headCounts: Record<string, number>;
  };
  notExitCounts: Record<string, number>;
  slippage: { n: number; avgAbsBp: number; maxAbsBp: number; p90AbsBp: number };
  fees: {
    entryTotal: number;
    exitTotal: number;
    notionalTotal: number;
    feePerNotionalPct: number;
    vsTpThrPct: number | null;
  };
  funding: { incomeSum: number; allocatedEst: number };
  audit: { ts: number; time: string; note: string }[];
  failures: { orderFail: number; cancelFail: number; inflightBackoff: number; errors: Record<string, number> };
}

// ------------------------------------------------------------------ 解析

export function parseJsonl(text: string): EventRow[] {
  const out: EventRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as EventRow);
    } catch {
    }
  }
  return out;
}

// ------------------------------------------------------------------ 差分解

/**
 * 四类差距的量化分解（单位 USDT，对 thr 的差额）：
 * - basis：last 口径与 mark 口径的毛收益差（基 × 数量）
 * - exitFee：预估平仓费扣减（净口径判定的固定成本）
 * - trail*：追踪止盈的 arm/retrace 缺口 × 名义
 * - backoffOrCooldown：在途退避/冷却闸拦截时的整段净差距（判定已达标但没执行）
 */
export function decomposeGap(ev: EventRow): GapDecomposition {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  const rules = (ev.rules ?? {}) as Record<string, unknown>;
  const tp = (rules.tpUsdt ?? {}) as { thr?: number; gap?: number };
  const gap = num(tp.gap); // thr - net，>0 表示净口径尚未达标
  const net = num(ev.net);
  const netAtLast = num(ev.netAtLast);
  const exitFee = num(ev.exitFeeEst);
  const notional = num(ev.netNotional);
  const trail = (rules.trail ?? {}) as Record<string, unknown>;
  const gapToArm = Math.max(0, num(trail.gapToArmPct));
  const gapToRetrace = Math.max(0, num(trail.gapToGivebackPct));

  const feePart = Math.max(0, Math.min(gap, exitFee));
  const remainingAfterFee = Math.max(0, gap - feePart);
  // last-vs-mark 的 USDT 差（netAtLast-net == grossAtLast-gross，平仓费两边同额抵消）
  const basisDelta = Math.max(0, netAtLast - net);
  const basisPart = Math.min(remainingAfterFee, basisDelta);
  const trailNotArmed = gapToArm * notional;
  const trailNoRetrace = gapToRetrace * notional;
  // 执行闸拦截（在途退避/冷却）：判定已达标但未执行 → 整段 gap 归 gate
  const gate = num(ev.inflight) > 0 || num(ev.cooldownLeftSec) > 0 ? gap : 0;

  const d: GapDecomposition = {
    total: round(gap),
    basis: round(basisPart),
    exitFee: round(feePart),
    trailNotArmed: round(trailNotArmed),
    trailNoRetrace: round(trailNoRetrace),
    backoffOrCooldown: round(gate),
    unattributed: 0,
  };
  const explained = gate > 0 ? 0 : feePart + basisPart + trailNotArmed + trailNoRetrace;
  d.unattributed = round(Math.max(0, gap - explained));
  return d;
}

/** 未达标归因：退避/冷却优先（执行层事实），否则取最大分量 */
export function classifyMiss(ev: EventRow, d: GapDecomposition): Bucket | 'NONE' {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (num(ev.inflight) > 0 || num(ev.cooldownLeftSec) > 0) return 'backoffOrCooldown';
  const cand: Array<[Bucket, number]> = [
    ['basis', d.basis],
    ['exitFee', d.exitFee],
    ['trailNotArmed', d.trailNotArmed],
    ['trailNoRetrace', d.trailNoRetrace],
    ['unattributed', d.unattributed],
  ];
  let best: Bucket | 'NONE' = 'NONE';
  let max = 0;
  for (const [k, v] of cand) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

// ------------------------------------------------------------------ 主分析

const BUCKETS: Bucket[] = ['basis', 'exitFee', 'trailNotArmed', 'trailNoRetrace', 'backoffOrCooldown', 'unattributed'];

export function analyze(input: AnalyzeInput): AnalyzeReport {
  const { events, openLots, funding, candles, failedOrders } = input;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  // ---- 轮次（篮子）清单：BASKET 事件 × LOT_SETTLE 配对 ----
  const settles = events.filter((e) => e.type === 'LOT_SETTLE');
  const basketEvents = events.filter((e) => e.type === 'BASKET');
  const lotByBasketCode = new Map<string, EventRow[]>();
  for (const s of settles) {
    const code = String(s.basketCode ?? '-');
    const arr = lotByBasketCode.get(code) ?? [];
    arr.push(s);
    lotByBasketCode.set(code, arr);
  }

  // funding 摊派：结算时刻 ±4h 窗内 FUNDING_FEE 流水，按该窗名义占比估算
  const matchOpenLot = (s: EventRow): OpenLotInfo | null => {
    const dir = String(s.direction);
    const qty = num(s.quantity);
    let best: OpenLotInfo | null = null;
    for (const l of openLots) {
      if (l.direction !== dir || Math.abs(l.quantity - qty) > 1e-9) continue;
      if (Math.abs(l.openedAt - num(s.ts)) > 130_000) continue; // 事件与开仓落盘大致同时
      if (!best || Math.abs(l.openedAt - num(s.ts)) < Math.abs(best.openedAt - num(s.ts))) best = l;
    }
    return best;
  };

  const fundingSum = funding.reduce((a, f) => a + f.amount, 0);
  let allocatedEst = 0;
  const totalLotNotional = openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0) || 1;

  // ---- 出场时序：EXIT_TRACE 段（同篮子判定流），exit 事件后紧跟的 SETTLE 是成交对 ----
  const exitTraces = events.filter((e) => e.type === 'EXIT_TRACE');
  const segExits = exitTraces.filter((e) => e.exit !== undefined && e.notExit === undefined);

  // 滑点：exit 判定行的 last/mark vs 其后 settle 实际均价（按数量加权）
  const slipBp: number[] = [];
  for (const ex of segExits) {
    const after = settles.filter((s) => s.ts >= ex.ts && s.ts - ex.ts < 180_000);
    if (after.length === 0) continue;
    const qtySum = after.reduce((a, s) => a + num(s.quantity), 0);
    const avgExit = after.reduce((a, s) => a + num(s.exitPrice) * num(s.quantity), 0) / (qtySum || 1);
    const dirSign = String(after[0].direction) === 'LONG' ? 1 : -1;
    const basis = dirSign * ((avgExit - num(ex.last)) / num(ex.last)) * 1e4;
    if (Number.isFinite(basis)) slipBp.push(Math.abs(basis));
  }
  const sortedSlip = [...slipBp].sort((a, b) => a - b);
  const avgAbsBp = sortedSlip.length ? sortedSlip.reduce((a, b) => a + b, 0) / sortedSlip.length : 0;
  const p90 = sortedSlip.length ? sortedSlip[Math.min(sortedSlip.length - 1, Math.floor(sortedSlip.length * 0.9))] : 0;

  // ---- 篮子清单 ----
  const tpThr = input.tpThrUsdt ?? 0;
  const detail: BasketSummary[] = [];
  const buildBasket = (code: string, ev: EventRow | null): BasketSummary => {
    const lots = lotByBasketCode.get(code) ?? [];
    const notional = lots.reduce((a, s) => a + num(s.entryPrice) * num(s.quantity), 0);
    const feeActual = lots.reduce((a, s) => {
      const l = matchOpenLot(s);
      return a + (l ? l.entryFee : 0) + (l ? l.exitFee ?? 0 : 0);
    }, 0);
    const fundingEst = notional ? (Math.abs(fundingSum) * notional) / totalLotNotional : 0;
    allocatedEst += fundingEst;
    let sl: BasketSummary['slippage'] = null;
    if (ev || lots.length) {
      const t0 = ev ? num(ev.ts) : Math.min(...lots.map((l) => num(l.ts)), Infinity);
      const exNear = segExits.filter((e) => Math.abs(e.ts - t0) < 120_000);
      if (exNear.length && lots.length) {
        const qtySum = lots.reduce((a, s) => a + num(s.quantity), 0);
        const avgExit = lots.reduce((a, s) => a + num(s.exitPrice) * num(s.quantity), 0) / (qtySum || 1);
        const dirSign = String(lots[0].direction) === 'LONG' ? 1 : -1;
        const bp = Math.abs((dirSign * (avgExit - num(exNear[0].last)) / num(exNear[0].last)) * 1e4);
        sl = { n: lots.length, avgAbsBp: bp, maxAbsBp: bp };
      }
    }
    const holdMs =
      openLots.length && lots.length
        ? Math.max(
            ...lots.map((s) => {
              const l = matchOpenLot(s);
              return l && l.closedAt ? l.closedAt - l.openedAt : 0;
            }),
          ) || null
        : null;
    return {
      code,
      layerCount: ev ? num(ev.layerCount) : lots.length,
      realizedPnl: ev ? num(ev.realizedPnl) : lots.reduce((a, s) => a + num(s.realizedPnl), 0),
      feeTotal: ev ? num(ev.feeTotal) : feeActual,
      exitReason: lots.length ? String(lots[0].exitReason ?? null) : null,
      holdMs,
      notional,
      feeActual,
      fundingEst,
      slippage: sl,
      decision: { exit: null, notExitLast: null },
    };
  };

  const seenCodes = new Set<string>();
  for (const b of basketEvents) {
    const code = String(b.code ?? '-');
    seenCodes.add(code);
    // 同一轮判定流：篮子结算前 10 分钟内的 EXIT_TRACE
    const seg = exitTraces.filter((e) => num(e.ts) <= num(b.ts) && num(b.ts) - num(e.ts) < 600_000);
    const lastExit = seg.filter((e) => e.exit !== undefined).at(-1);
    const lastNo = seg.filter((e) => e.notExit !== undefined).at(-1);
    const d = buildBasket(code, b);
    d.decision = {
      exit: lastExit ? String(lastExit.exit) : null,
      notExitLast: lastNo ? String(lastNo.notExit) : null,
    };
    detail.push(d);
  }
  // BASKET 缺失时按 SETTLE 的 basketCode 归堆兜底
  for (const code of lotByBasketCode.keys()) {
    if (!seenCodes.has(code) && code !== '-') detail.push(buildBasket(code, null));
  }

  // ---- 未触发审计：EXIT_TRACE 连续段，netAtLast 越过 thr 但 net 未越 ----
  const basisEvents: BasisEvent[] = [];
  const notExitCounts: Record<string, number> = {};
  for (const ev of exitTraces) {
    if (ev.notExit !== undefined) {
      const k = String(ev.notExit);
      notExitCounts[k] = (notExitCounts[k] ?? 0) + 1;
    }
    if (ev.notExit !== 'NO_RULE_HIT') continue;
    const rules = (ev.rules ?? {}) as Record<string, { thr?: number; gap?: number }>;
    const thrTp = num(rules.tpUsdt?.thr);
    const netAtLast = num(ev.netAtLast);
    const net = num(ev.net);
    if (thrTp > 0 && netAtLast >= thrTp && net < thrTp) {
      const d = decomposeGap(ev);
      basisEvents.push({
        ts: num(ev.ts),
        time: String(ev.time),
        rule: 'TP',
        direction: 'LONG',
        netAtLast,
        net,
        thr: thrTp,
        gapUsdt: thrTp - net,
        gapPct: netAtLast ? (thrTp - net) / netAtLast : 0,
        decomp: d,
        headClass: classifyMiss(ev, d),
      });
    }
    // SL 方向同理（面板价已达止损却没触发 = 同样要归因）
    const thrSl = num(rules.slUsdt?.thr);
    if (thrSl < 0 && netAtLast <= thrSl && net > thrSl) {
      const d = decomposeGap(ev);
      basisEvents.push({
        ts: num(ev.ts),
        time: String(ev.time),
        rule: 'SL',
        direction: 'SHORT',
        netAtLast,
        net,
        thr: thrSl,
        gapUsdt: net - thrSl,
        gapPct: Math.abs(netAtLast) ? (net - thrSl) / Math.abs(netAtLast) : 0,
        decomp: d,
        headClass: classifyMiss(ev, d),
      });
    }
  }

  // 差距聚合
  const counts: Record<string, number> = {};
  const sumUsdt: Record<string, number> = {};
  const headCounts: Record<string, number> = {};
  for (const b of basisEvents) {
    for (const k of BUCKETS) {
      if (Math.abs(b.decomp[k]) > 1e-9) {
        counts[k] = (counts[k] ?? 0) + 1;
        sumUsdt[k] = (sumUsdt[k] ?? 0) + Math.abs(b.decomp[k]);
      }
    }
    if (b.headClass !== 'NONE') headCounts[b.headClass] = (headCounts[b.headClass] ?? 0) + 1;
  }

  // ---- 1m K 线审计：每条 basisEvent 后 10 分钟窗内实际价是否穿越隐含触发价。
  // 穿越且窗内无 exit 执行→「该触发没触发」（嫌疑）；未穿越→面板越线只是基差假象。
  const audit: AnalyzeReport['audit'] = [];
  for (const b of basisEvents.slice(0, 30)) {
    const src = exitTraces.find((e) => num(e.ts) === b.ts);
    const notional = num(src?.netNotional);
    if (!notional) continue;
    const lastPrice = num(src?.last);
    // 隐含触发价：last 价需再多走 gapUsdt/名义 的距离（净口径线性近似，毛口径同斜率）
    const implied =
      b.rule === 'TP' ? lastPrice + (b.gapUsdt / notional) * lastPrice : lastPrice - (b.gapUsdt / notional) * lastPrice;
    const win = candles.filter((c) => c.openTime > b.ts && c.openTime - b.ts < 600_000);
    if (!win.length) continue;
    const crossed = b.rule === 'TP' ? win.some((c) => c.high >= implied) : win.some((c) => c.low <= implied);
    const exitedInWin = segExits.some((e) => e.ts > b.ts && e.ts - b.ts < 600_000);
    audit.push({
      ts: b.ts,
      time: b.time,
      note:
        `rule=${b.rule} gap=${b.gapUsdt.toFixed(2)}U head=${b.headClass} 隐含触发价=${implied.toFixed(2)}` +
        (crossed && !exitedInWin
          ? ' → K 线后续穿越且未执行（该触发没触发的嫌疑）'
          : crossed
            ? ' → 后续穿越且已执行（时差内的正常延迟）'
            : ' → 后续未穿越（面板越线是基差假象，判定正确）'),
    });
  }

  // ---- 层数分布 ----
  const layers: AnalyzeReport['layers'] = { max: 0, histogram: {} };
  for (const d of detail) {
    if (d.layerCount === null) continue;
    layers.max = Math.max(layers.max, d.layerCount);
    layers.histogram[d.layerCount] = (layers.histogram[d.layerCount] ?? 0) + 1;
  }

  // ---- 费用与失败 ----
  let entryTotal = 0;
  let exitTotal = 0;
  const notionalTotal = openLots.reduce((a, l) => a + l.entryPrice * l.quantity, 0);
  for (const s of settles) {
    const l = matchOpenLot(s);
    if (l) {
      entryTotal += l.entryFee;
      exitTotal += l.exitFee ?? 0;
    }
  }
  const errors: Record<string, number> = {};
  let cancelFail = 0;
  let inflightBackoff = 0;
  for (const ev of exitTraces) {
    if (ev.notExit === 'CANCEL_FAIL') cancelFail++;
    if (ev.notExit === 'INFIGHT_BACKOFF') inflightBackoff++;
  }
  for (const f of failedOrders) {
    const code = /"code":\s*(-?\d+)|(-?\d{4,5})/.exec(f.error ?? '')?.[1] ?? f.error?.slice(0, 40) ?? 'UNKNOWN';
    errors[code] = (errors[code] ?? 0) + 1;
  }

  const rounds = {
    tp: detail.filter((d) => d.exitReason === 'TAKE_PROFIT').length,
    sl: detail.filter((d) => d.exitReason === 'STOP_LOSS').length,
    other: detail.filter((d) => d.exitReason !== 'TAKE_PROFIT' && d.exitReason !== 'STOP_LOSS').length,
    pnlSum: detail.reduce((a, d) => a + (d.realizedPnl ?? 0), 0),
    detail,
  };

  return {
    meta: {
      day: '',
      inst: '',
      events: events.length,
      exitTrace: exitTraces.length,
      entryTrace: events.filter((e) => e.type === 'ENTRY_TRACE').length,
      settles: settles.length,
      baskets: basketEvents.length,
      generatedAt: new Date().toISOString(),
    },
    layers,
    rounds,
    basisEvents,
    gapAgg: { counts, sumUsdt, headCounts },
    notExitCounts,
    slippage: { n: sortedSlip.length, avgAbsBp, maxAbsBp: sortedSlip.at(-1) ?? 0, p90AbsBp: p90 },
    fees: {
      entryTotal,
      exitTotal,
      notionalTotal,
      feePerNotionalPct: notionalTotal ? ((entryTotal + exitTotal) / notionalTotal) * 100 : 0,
      vsTpThrPct: tpThr > 0 ? ((entryTotal + exitTotal) / tpThr) * 100 : null,
    },
    funding: { incomeSum: fundingSum, allocatedEst },
    audit,
    failures: { orderFail: failedOrders.length, cancelFail, inflightBackoff, errors },
  };
}
