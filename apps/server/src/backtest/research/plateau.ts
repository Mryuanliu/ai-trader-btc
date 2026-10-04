import type { PlateauResult } from '@ai-trader/shared';

/**
 * 参数高原 / 孤峰检验（López de Prado WFA 稳健性思想的参数维度落地）。
 *
 * 一个只在「精确这一点」漂亮、挪一格就崩的参数 = 对历史噪声的过拟合（孤峰）。
 * 主流做法：取冠军的**网格邻域**（每一维 ±1 step、其余维不动），比较其表现；
 * 若邻域最优相对冠军掉幅 > 阈值（默认 20%）→ 判孤峰，闸门拒绝。
 *
 * 纯函数：给定网格 + 每组 per-bar 夏普即可判定（可单测）。
 */
export interface PlateauInput {
  /** 原始网格：key → 升序候选值（未排序会自动排序） */
  grid: Record<string, number[]>;
  /** 与 sharpes 对齐的组合参数列表（每组的键须与 grid 的键一致） */
  combos: Record<string, number>[];
  /** 各组合的 per-bar 夏普（与 combos 同序） */
  sharpes: number[];
  /** 冠军在 combos 中的下标 */
  bestIndex: number;
  /** 最大允许邻域掉幅（比例），默认 0.2 */
  maxDropRatio?: number;
}

/** 邻居匹配容差（浮点网格值） */
const EPS = 1e-9;

export function computePlateau(input: PlateauInput): PlateauResult {
  const { grid, combos, sharpes, bestIndex } = input;
  const maxDropRatio = input.maxDropRatio ?? 0.2;
  const champion = combos[bestIndex];
  const championSharpe = sharpes[bestIndex];

  const sortedVals: Record<string, number[]> = {};
  for (const key of Object.keys(grid)) {
    sortedVals[key] = [...(grid[key] ?? [])].sort((a, b) => a - b);
  }

  const findComboIndex = (target: Record<string, number>): number =>
    combos.findIndex((c) =>
      Object.keys(target).every((k) => Math.abs((c[k] ?? Number.NaN) - target[k]) < EPS),
    );

  const neighborSharpes: number[] = [];
  for (const key of Object.keys(sortedVals)) {
    const vals = sortedVals[key];
    const at = vals.findIndex((v) => Math.abs(v - champion[key]) < EPS);
    if (at < 0) continue;
    for (const step of [-1, 1]) {
      const ni = at + step;
      if (ni < 0 || ni >= vals.length) continue;
      const target = { ...champion, [key]: vals[ni] };
      const idx = findComboIndex(target);
      if (idx >= 0 && idx !== bestIndex) neighborSharpes.push(sharpes[idx]);
    }
  }

  // 掉幅 = (冠军 − 邻居) / |冠军|；邻居更好则为负（不计入劣化）
  let worstDropPct = 0;
  if (Math.abs(championSharpe) > EPS) {
    for (const ns of neighborSharpes) {
      const drop = ((championSharpe - ns) / Math.abs(championSharpe)) * 100;
      if (drop > worstDropPct) worstDropPct = drop;
    }
  }

  const passed = neighborSharpes.length === 0 ? true : worstDropPct <= maxDropRatio * 100;

  return {
    passed,
    championSharpe: Number(championSharpe.toFixed(6)),
    neighborSharpes: neighborSharpes.map((s) => Number(s.toFixed(6))),
    worstNeighborDropPct: Number(worstDropPct.toFixed(4)),
    neighborCount: neighborSharpes.length,
  };
}
