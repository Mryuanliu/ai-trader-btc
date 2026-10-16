// ---------------------------------------------------------------------------
// M4 出场优先级链（方案 M4 / W5）——纯函数层
//
// 移植自 king-v4-balance.mq5 TryAutoCloseLogic（L3405–3428）的短路顺序：
//   1) 首单追踪（G7，L3122–3180）→ 2) 篮子追踪双口径（G14，L3056–3115）
//   → 3) 分侧均值目标 + 域分流（G5，L3282–3378）→ 4) 趋势保护配对减仓（G6，
//   L2393–2530）→ 5) 兜底固定止损/止盈（现有 checkBasketExit，最外层保险）。
// 点值 → K 线口径换算（C-1）：trail 触发金 = 1 个网格 step × 手数；
// 回撤离场 = 判定价自峰值回撤（篮子按 retracePct，首单按 step 价格距）。
// ---------------------------------------------------------------------------
import { sideTargetMult } from './score-sizing';

export type Side = 'LONG' | 'SHORT';

/** 配对减仓候选的归一视图（净值已扣预估平仓费） */
export interface LotNetView {
  id: string;
  direction: Side;
  quantity: number;
  /** 该单净收益（USDT） */
  netUsdt: number;
  /** 不利距离（价格单位）：LONG=max(0, entry−price)，SHORT=max(0, price−entry) */
  adverseDist: number;
}

/** 域分流（EA TryProtectiveCloseBySide L3293/L3313/L3345 的三段结构） */
export function scoreDomain(score: number, dir: number, trendRange: number): 'range' | 'neutral' | 'trend' {
  if (Math.abs(score) <= trendRange) return 'range';
  return dir === 0 ? 'neutral' : 'trend';
}

/**
 * 分侧均值目标（EA DynamicSideAverageOrderNetProfit L1674–1686 × 持仓数）：
 * 折算为名义比例口径——该侧名义 × sideTargetPct × 方向倍率。
 */
export function sideTargetUsdt(
  sideNotional: number,
  sideTargetPct: number,
  score: number,
  side: Side,
  trendRange: number,
): number {
  return sideNotional * sideTargetPct * sideTargetMult(score, side, trendRange);
}

/** 趋势保护比例（EA MarketTrendProtectionRatio L1490–1496）：<confirm → 0 */
export function trendProtectionMinRatio(absScore: number, trendConfirm: number): number {
  if (absScore < trendConfirm) return 0;
  // 卫句（2026-10-16 A13）：trendConfirm=100 时分母为 0 → NaN 会让趋势保护永不拦截
  const denom = 100 - trendConfirm;
  if (!(denom > 0)) return 0.55;
  return Math.min(0.55, Math.max(0.35, 0.35 + 0.2 * ((absScore - trendConfirm) / denom)));
}

/** 价格回撤判据（EA TrailPriceRetraced L2059 的比例形态） */
export function priceRetraced(
  dirSign: 1 | -1,
  peakPrice: number,
  curPrice: number,
  retracePct: number,
): boolean {
  if (!(peakPrice > 0) || !(curPrice > 0) || !(retracePct > 0)) return false;
  return dirSign > 0 ? curPrice <= peakPrice * (1 - retracePct) : curPrice >= peakPrice * (1 + retracePct);
}

/** 价格距离回撤判据（首单追踪用，EA L2064–2068 的绝对距离形态，1 个 step） */
export function distanceRetraced(dirSign: 1 | -1, peakPrice: number, curPrice: number, step: number): boolean {
  if (!(peakPrice > 0) || !(curPrice > 0) || !(step > 0)) return false;
  return dirSign > 0 ? curPrice <= peakPrice - step : curPrice >= peakPrice + step;
}

export interface PairGuard {
  /** 保护侧（趋势侧）总手数 */
  protectLotsQty: number;
  /** 逆风侧总手数 */
  riskLotsQty: number;
  minRatio: number;
  maxShare: number;
}

export interface PairPick {
  profit: LotNetView;
  risk: LotNetView;
  net: number;
}

/**
 * 配对减仓选对（EA FindProfitableReductionPair / FindTrendProtectedReductionPair
 * L2334–2504）。Lot 不可分割 → 两单**全平**，配对净值 = 两单全额净值之和
 * ≥ minNet（EA PAIR_CLOSE_MIN_NET=0.01U L31）。
 * 排序键照搬 EA（L2488–2491）：亏损侧不利距离最深 → 亏得多 → 新增：
 * 手数差最小（全平语义下控净敞口漂移，方案 M4-4）→ 配对净值更大。
 * guard=null = 中性域无趋势防护（EA TryPairedSideReduction L2393）。
 */
export function findReductionPair(args: {
  profitLots: LotNetView[];
  riskLots: LotNetView[];
  minNet: number;
  guard?: PairGuard | null;
  minLotQty?: number;
}): PairPick | null {
  const { profitLots, riskLots, minNet, guard, minLotQty = 0.001 } = args;
  let best: PairPick | null = null;
  for (const r of riskLots) {
    if (r.netUsdt >= 0) continue; // EA L2356：risk 必须亏损
    for (const p of profitLots) {
      if (p.netUsdt <= 0 || p.id === r.id) continue; // EA L2312：profit 必须为正
      const net = p.netUsdt + r.netUsdt;
      if (net < minNet) continue;
      if (guard) {
        // 帽按**保护侧实际减量**判（2026-10-16 A12）：Lot 不可分割、两单都全平，
        // 保护侧减少的就是 p.quantity。原来按 min(p.qty, r.qty) 判帽——
        // 顺势大手数 + 逆势小手数时帽放行而保护侧被打光，趋势防护失效。
        const cap = Math.max(minLotQty, guard.protectLotsQty * guard.maxShare);
        if (p.quantity > cap) continue; // EA L2436–2438：max_pair_share=0.30
        const afterProtect = Math.max(0, guard.protectLotsQty - p.quantity);
        const afterRisk = Math.max(0, guard.riskLotsQty - r.quantity);
        if (afterRisk > 0 && afterProtect < afterRisk * guard.minRatio) continue; // EA L2440
      }
      if (!best) {
        best = { profit: p, risk: r, net };
        continue;
      }
      const EPS = 1e-9;
      const better =
        r.adverseDist > best.risk.adverseDist + EPS ||
        (Math.abs(r.adverseDist - best.risk.adverseDist) <= EPS && r.netUsdt < best.risk.netUsdt - EPS) ||
        (Math.abs(r.adverseDist - best.risk.adverseDist) <= EPS &&
          Math.abs(r.netUsdt - best.risk.netUsdt) <= EPS &&
          Math.abs(p.quantity - r.quantity) < Math.abs(best.profit.quantity - best.risk.quantity) - EPS) ||
        (Math.abs(r.adverseDist - best.risk.adverseDist) <= EPS &&
          Math.abs(r.netUsdt - best.risk.netUsdt) <= EPS &&
          Math.abs(p.quantity - r.quantity) <= EPS &&
          net > best.net + EPS);
      if (better) best = { profit: p, risk: r, net };
    }
  }
  return best;
}
