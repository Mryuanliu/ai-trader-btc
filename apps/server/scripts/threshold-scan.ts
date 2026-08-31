/**
 * B1 · 阈值敏感性扫描
 *
 * 目的：回答「entryThreshold 该设多少」。
 *
 * 核心方法（方案 5.1）：扫描 0.20~0.85，统计每个阈值的触发次数，
 * **找平坦区间**——阈值小幅波动时触发次数变化不大的区间，那里才是稳健取值点。
 * 若某阈值附近斜率极陡（0.60→32 次、0.65→8 次），说明该值对噪声极敏感，是过拟合陷阱。
 *
 * 为什么用回测重放而非实盘观测：
 * 库里有 1.7 万根 5m K 线（两个月），样本比等几小时实盘大两个数量级，
 * 且能立刻得到 score 的真实分布。实盘数据只用于事后验证。
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/threshold-scan.ts
 *   npx ts-node -r tsconfig-paths/register scripts/threshold-scan.ts --interval=15m --warmup=200
 *   npx ts-node -r tsconfig-paths/register scripts/threshold-scan.ts --market=futures
 */
import { AppDataSource } from '../src/database/data-source';
import { MarketCandleEntity } from '../src/database/entities/market-candle.entity';
import { buildSignals, computeIndicators, scoreSignals, scoreSignalsDetailed } from '@ai-trader/shared';

// ---------------------------------------------------------------- 参数

interface Args {
  market: string;
  symbol: string;
  interval: string;
  /** 指标预热窗口：每根 K 线回看多少根来算指标（需覆盖最长周期指标，SMA60 至少 60） */
  warmup: number;
  /** 最小阈值 */
  min: number;
  /** 最大阈值 */
  max: number;
  /** 步长 */
  step: number;
  /**
   * 打分口径：legacy（分子表态/分母全部，会被稀释）| consensus（分子分母都只算表态）。
   * 阈值必须与其口径匹配——在 legacy 下校准的 0.85，切到 consensus 后会失效。
   */
  scoreMode: 'legacy' | 'consensus';
  /** consensus 口径下的最小表态率（双条件之一） */
  minAgreement: number;
}

function parseArgs(): Args {
  const get = (k: string, d: string) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : d;
  };
  return {
    market: get('market', 'spot'),
    symbol: get('symbol', 'BTCUSDT'),
    interval: get('interval', '5m'),
    warmup: Number(get('warmup', '300')),
    min: Number(get('min', '0.20')),
    max: Number(get('max', '0.85')),
    step: Number(get('step', '0.05')),
    scoreMode: get('scoreMode', 'legacy') === 'consensus' ? 'consensus' : 'legacy',
    minAgreement: Number(get('minAgreement', '0.6')),
  };
}

// ---------------------------------------------------------------- 输出格式

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function bar(count: number, max: number, width = 30): string {
  const filled = max === 0 ? 0 : Math.round((count / max) * width);
  return '█'.repeat(Math.min(width, filled)) + '·'.repeat(Math.max(0, width - filled));
}

// ---------------------------------------------------------------- 主流程

interface ScanResult {
  threshold: number;
  buy: number;
  sell: number;
  total: number;
  /** 触发率（触发次数 / 样本数） */
  rate: number;
}

/** 扫描样本：score 为生效口径下的分值，agreement 用于 consensus 模式的双条件 */
interface Sample {
  score: number;
  agreement: number;
}

/** 对给定样本序列扫描各阈值的触发次数 */
function scan(samples: Sample[], args: Args): ScanResult[] {
  const out: ScanResult[] = [];
  for (let t = args.min; t <= args.max + 1e-9; t += args.step) {
    const th = Number(t.toFixed(2));
    let buy = 0;
    let sell = 0;
    for (const s of samples) {
      // consensus 口径是双条件：一致度达标 **且** 表态率达标
      if (args.scoreMode === 'consensus' && s.agreement < args.minAgreement) continue;
      if (s.score >= th) buy += 1;
      else if (s.score <= -th) sell += 1;
    }
    out.push({
      threshold: th,
      buy,
      sell,
      total: buy + sell,
      rate: samples.length === 0 ? 0 : (buy + sell) / samples.length,
    });
  }
  return out;
}

/** 打印扫描表：触发次数 + 相邻斜率 + 平坦标记 */
function printScan(title: string, rows: ScanResult[], sampleCount: number) {
  console.log(`\n${title}（样本 ${sampleCount} 根）`);
  console.log('─'.repeat(78));
  console.log(
    `${pad('阈值', 8)}${pad('BUY', 8, true)}${pad('SELL', 8, true)}${pad('合计', 8, true)}` +
      `${pad('触发率', 10, true)}${pad('较上一级', 12, true)}  分布`,
  );
  console.log('─'.repeat(78));

  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    // 相对上一级的衰减比例：衡量斜率。越接近 1 越平坦
    let slope = '';
    let flat = '';
    if (prev && prev.total > 0) {
      const ratio = r.total / prev.total;
      slope = `${(ratio * 100).toFixed(0)}%`;
      // 平坦：衰减不超过 35%（触发次数没有崩塌）
      flat = ratio >= 0.65 ? '  ← 平坦' : ratio < 0.4 ? '  ⚠ 陡降' : '';
    }
    console.log(
      `${pad(r.threshold.toFixed(2), 8)}${pad(r.buy, 8, true)}${pad(r.sell, 8, true)}` +
        `${pad(r.total, 8, true)}${pad(`${(r.rate * 100).toFixed(2)}%`, 10, true)}` +
        `${pad(slope, 12, true)}  ${bar(r.total, maxTotal)}${flat}`,
    );
  }
  console.log('─'.repeat(78));
}

/**
 * 识别平坦区间：连续若干级衰减都在可接受范围内（>= 0.65），
 * 取最长的一段作为推荐区间，并给出中点。
 */
function findPlateau(rows: ScanResult[]): { from: number; to: number; mid: number } | null {
  let best: { from: number; to: number; mid: number } | null = null;
  let curStart = 0;

  for (let i = 1; i <= rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const ratio = cur && prev.total > 0 ? cur.total / prev.total : 0;
    const isFlat = cur && ratio >= 0.65;

    if (!isFlat) {
      // 区间结束，评估 [curStart, i-1]
      const len = i - 1 - curStart;
      if (len >= 1 && (!best || len > best.to - best.from)) {
        best = {
          from: rows[curStart].threshold,
          to: rows[i - 1].threshold,
          mid: Number(((rows[curStart].threshold + rows[i - 1].threshold) / 2).toFixed(3)),
        };
      }
      curStart = i;
    }
  }
  return best;
}

function printDistribution(scores: number[]) {
  const abs = scores.map((s) => Math.abs(s)).sort((a, b) => a - b);
  if (abs.length === 0) return;
  const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  console.log('\n【|score| 分布】—— 阈值必须落在分布的合理位置，否则永远不触发');
  console.log(`  样本数 ${abs.length}`);
  console.log(
    `  中位数 ${q(0.5).toFixed(3)} | 75分位 ${q(0.75).toFixed(3)} | 90分位 ${q(0.9).toFixed(3)} | ` +
      `95分位 ${q(0.95).toFixed(3)} | 99分位 ${q(0.99).toFixed(3)} | 最大 ${abs[abs.length - 1].toFixed(3)}`,
  );

  // 分桶直方图，直观看分布形态
  console.log('\n  |score| 直方图（0~1 分 10 档）:');
  const buckets = new Array(10).fill(0);
  for (const v of abs) {
    const idx = Math.min(9, Math.floor(v * 10));
    buckets[idx] += 1;
  }
  const maxB = Math.max(...buckets, 1);
  buckets.forEach((c, i) => {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    console.log(`  ${lo}~${hi}  ${pad(c, 7, true)} ${bar(c, maxB, 28)}`);
  });
}

async function main() {
  const args = parseArgs();
  console.log('═'.repeat(78));
  console.log('B1 · entryThreshold 敏感性扫描');
  console.log(`市场 ${args.market} · ${args.symbol} · ${args.interval} · 预热窗口 ${args.warmup} 根`);
  console.log('═'.repeat(78));

  await AppDataSource.initialize();

  const rows = await AppDataSource.getRepository(MarketCandleEntity).find({
    where: {
      symbol: args.symbol,
      market: args.market as never,
      interval: args.interval as never,
    },
    order: { openTime: 'ASC' },
  });

  console.log(`\n加载到 ${rows.length} 根 K 线`);
  if (rows.length < args.warmup + 10) {
    console.error(`❌ K 线不足（需要 > ${args.warmup + 10} 根才能扫描）`);
    await AppDataSource.destroy();
    process.exit(1);
  }

  const candles = rows.map((r) => ({
    time: Number(r.openTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  // 滚窗计算 score 序列：每根 K 线回看 warmup 根算指标（模拟真实逐 bar 推进）
  console.log(`滚窗计算指标与综合分（${candles.length - args.warmup} 次）...`);
  const started = Date.now();
  const scores: Sample[] = [];
  const times: number[] = [];

  for (let i = args.warmup; i < candles.length; i += 1) {
    const window = candles.slice(Math.max(0, i - args.warmup + 1), i + 1);
    const ind = computeIndicators(window as never);
    const sigs = buildSignals(ind as never, window as never);
    const d = scoreSignalsDetailed(sigs);
    scores.push({
      // 按生效口径取值：legacy 用被稀释的 score，consensus 用一致度
      score: args.scoreMode === 'consensus' ? d.consensus : scoreSignals(sigs),
      agreement: d.agreement,
    });
    times.push(candles[i].time);
  }
  console.log(
    `完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，产出 ${scores.length} 个样本（口径 ${args.scoreMode}）`,
  );
  if (args.scoreMode === 'consensus') {
    const eligible = scores.filter((s) => s.agreement >= args.minAgreement).length;
    console.log(
      `表态率 >= ${args.minAgreement} 的样本：${eligible} / ${scores.length}（${((eligible / scores.length) * 100).toFixed(2)}%）`,
    );
  }

  printDistribution(scores.map((s) => s.score));

  // ---------- 全样本扫描 ----------
  const all = scan(scores, args);
  printScan('【全样本扫描】', all, scores.length);

  const plateau = findPlateau(all);
  if (plateau) {
    console.log(
      `\n✅ 建议平坦区间：${plateau.from.toFixed(2)} ~ ${plateau.to.toFixed(2)}（中点 ${plateau.mid}）`,
    );
  } else {
    console.log('\n⚠️ 未识别到平坦区间（各阈值触发次数衰减均较快）');
  }

  // ---------- 前后窗交叉验证 ----------
  // 关键：平坦区间必须在两个独立时间窗上都成立，否则只是这段行情的巧合
  const half = Math.floor(scores.length / 2);
  const front = scan(scores.slice(0, half), args);
  const back = scan(scores.slice(half), args);
  printScan('【前窗扫描 · in-sample】', front, half);
  printScan('【后窗扫描 · out-of-sample】', back, scores.length - half);

  const frontPlateau = findPlateau(front);
  const backPlateau = findPlateau(back);
  console.log('\n【交叉验证】—— 平坦区间是否在两个独立时间窗都成立');
  console.log(`  前窗平坦区间：${frontPlateau ? `${frontPlateau.from}~${frontPlateau.to}（中点 ${frontPlateau.mid}）` : '无'}`);
  console.log(`  后窗平坦区间：${backPlateau ? `${backPlateau.from}~${backPlateau.to}（中点 ${backPlateau.mid}）` : '无'}`);
  if (frontPlateau && backPlateau) {
    const overlapLo = Math.max(frontPlateau.from, backPlateau.from);
    const overlapHi = Math.min(frontPlateau.to, backPlateau.to);
    if (overlapLo <= overlapHi) {
      console.log(`  ✅ 两窗重叠区间 ${overlapLo.toFixed(2)}~${overlapHi.toFixed(2)} → 推荐取值 ${((overlapLo + overlapHi) / 2).toFixed(3)}`);
    } else {
      console.log('  ⚠️ 两窗无重叠，说明平坦区间不稳定，需扩大扫描范围或改用其他口径');
    }
  }

  // ---------- 关键阈值对照 ----------
  console.log('\n【关键阈值对照】');
  const maxAbs = Math.max(...scores.map((s) => Math.abs(s.score)));
  console.log(`  实测 |score| 最大值 = ${maxAbs.toFixed(3)}`);
  console.log(`  当前线上阈值 = 0.850 → 触发 ${all.find((r) => r.threshold === 0.85)?.total ?? 0} 次`);
  const reachable = all.filter((r) => r.total > 0);
  if (reachable.length) {
    console.log(`  有触发的最高阈值 = ${reachable[reachable.length - 1].threshold.toFixed(2)}（${reachable[reachable.length - 1].total} 次）`);
  }
  console.log(`  结论：线上 0.85 ${maxAbs < 0.85 ? '高于历史最大可达值，结构性失灵（从不触发）' : '可达，但需评估触发频率是否合理'}`);

  await AppDataSource.destroy();
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('扫描失败:', e);
  process.exit(1);
});
