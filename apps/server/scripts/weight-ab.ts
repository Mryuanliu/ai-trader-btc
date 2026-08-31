/**
 * C2 · 权重方案对照回测（样本内 + 样本外）
 *
 * 目的：验证 C1 的 IC 结论能否转化为真实绩效提升。
 *
 * C1 发现：5 个趋势信号 IC 为负、只有 bollinger（均值回归）IC 为正。
 * 本脚本用**统一的最小回测框架**对比几种权重方案，看哪种绩效最好。
 * 关键是**样本内/样本外对照**——只在样本内好的方案是过拟合。
 *
 * 注意：这是**简化的对照回测**（固定仓位、按收盘价成交、含手续费），
 * 目的是横向对比权重方案的相对优劣，不是精确绩效评估。
 * 最终结论应以完整回测引擎（含滑点、minNotional、风控）为准。
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/weight-ab.ts
 *   npx ts-node -r tsconfig-paths/register scripts/weight-ab.ts --split=0.7 --threshold=0.85
 */
import { AppDataSource } from '../src/database/data-source';
import { MarketCandleEntity } from '../src/database/entities/market-candle.entity';
import { buildSignals, computeIndicators } from '@ai-trader/shared';
import type { RsiMode } from '@ai-trader/shared';

interface Args {
  market: string;
  symbol: string;
  interval: string;
  warmup: number;
  /** 训练/测试切分比例（前 x 为样本内，其余样本外） */
  split: number;
  threshold: number;
  /** 单边手续费率 */
  feeRate: number;
  rsiMode: RsiMode;
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
    split: Number(get('split', '0.7')),
    threshold: Number(get('threshold', '0.85')),
    feeRate: Number(get('feeRate', '0.001')), // 10bps
    rsiMode: get('rsiMode', 'reversion') === 'trend' ? 'trend' : 'reversion',
  };
}

/** 信号名与方向：1=该信号看多时对未来正贡献，-1=反向（C1 测得 IC 为负） */
type Weights = Record<string, number>;

/** 各对比方案 */
const SCHEMES: { name: string; desc: string; weights: Weights }[] = [
  {
    name: 'baseline',
    desc: '当前线上权重（拍脑袋）',
    weights: { ma_trend: 0.25, rsi: 0.2, macd: 0.2, bollinger: 0.15, volume: 0.1, mid_term: 0.1 },
  },
  {
    name: 'ic_weighted',
    desc: '按 |IC| 归一化（方向不变）',
    weights: { ma_trend: 0.218, rsi: 0.172, macd: 0.064, bollinger: 0.179, volume: 0.084, mid_term: 0.282 },
  },
  {
    name: 'ic_sign_fixed',
    desc: '按 IC 符号修正方向 + |IC| 加权',
    // 趋势信号 IC 为负 → 取反；bollinger IC 为正 → 保持
    weights: { ma_trend: -0.218, rsi: -0.172, macd: -0.064, bollinger: 0.179, volume: -0.084, mid_term: -0.282 },
  },
  {
    name: 'boll_only',
    desc: '只用 bollinger（唯一正 IC）',
    weights: { bollinger: 1.0 },
  },
  {
    name: 'equal',
    desc: '等权（对照组：无任何先验）',
    weights: { ma_trend: 1 / 6, rsi: 1 / 6, macd: 1 / 6, bollinger: 1 / 6, volume: 1 / 6, mid_term: 1 / 6 },
  },
];

/** 绩效指标 */
interface Perf {
  /** 总收益率 */
  totalReturn: number;
  /** 交易次数 */
  trades: number;
  /** 胜率 */
  winRate: number;
  /** 年化夏普（按 bar 数折算，5m 一年约 105120 根） */
  sharpe: number;
  /** 最大回撤 */
  maxDrawdown: number;
}

/** 简单回测：score 超阈值开多/开空，反向或归零时平仓 */
function backtest(
  scores: number[],
  closes: number[],
  threshold: number,
  feeRate: number,
  /** 最小持仓 bar 数（限频，避免手续费把本金磨光） */
  minHoldBars = 12,
): Perf {
  let position: 0 | 1 | -1 = 0; // 0=空仓 1=多 -1=空
  let entryPrice = 0;
  let entryIdx = 0;
  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  let trades = 0;
  let wins = 0;
  const returns: number[] = [];
  let prevEquity = 1.0;

  for (let i = 0; i < scores.length; i += 1) {
    const price = closes[i];
    const s = scores[i];
    let target: 0 | 1 | -1 = s >= threshold ? 1 : s <= -threshold ? -1 : 0;

    // 限频：持仓未满 minHoldBars 不允许改仓（与线上 minOrderInterval 的精神一致）
    // 没有这个限制，交易次数会爆炸，手续费（双边 0.2%）足以吞掉全部本金
    if (position !== 0 && i - entryIdx < minHoldBars) target = position;

    if (target !== position) {
      // 平仓（含手续费）
      if (position !== 0) {
        const pnl = ((price - entryPrice) / entryPrice) * position;
        equity *= 1 + pnl - feeRate;
        trades += 1;
        if (pnl > 0) wins += 1;
      }
      // 开仓（含手续费）
      if (target !== 0) {
        entryPrice = price;
        entryIdx = i;
        equity *= 1 - feeRate;
      }
      position = target;
    }

    // 记录权益变化（用于夏普与回撤）
    const r = equity / prevEquity - 1;
    if (Number.isFinite(r)) returns.push(r);
    prevEquity = equity;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }

  // 强制平掉末尾仓位，避免"未实现盈亏"污染对比
  if (position !== 0) {
    const price = closes[closes.length - 1];
    const pnl = ((price - entryPrice) / entryPrice) * position;
    equity *= 1 + pnl - feeRate;
  }

  const meanR = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const varR = returns.length
    ? returns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (returns.length - 1 || 1)
    : 0;
  const stdR = Math.sqrt(varR);
  // 年化：5m bar 一年约 105120 根
  const annualFactor = Math.sqrt(105120);
  const sharpe = stdR === 0 ? 0 : (meanR / stdR) * annualFactor;

  return {
    totalReturn: equity - 1,
    trades,
    winRate: trades === 0 ? 0 : wins / trades,
    sharpe,
    maxDrawdown: maxDd,
  };
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

async function main() {
  const args = parseArgs();
  console.log('═'.repeat(104));
  console.log('C2 · 权重方案对照回测（样本内 / 样本外）');
  console.log(
    `${args.symbol} ${args.interval} · 阈值 ${args.threshold} · 手续费 ${(args.feeRate * 100).toFixed(2)}% · ` +
      `切分 ${(args.split * 100).toFixed(0)}% 样本内`,
  );
  console.log('═'.repeat(104));

  await AppDataSource.initialize();
  const rows = await AppDataSource.getRepository(MarketCandleEntity).find({
    where: { symbol: args.symbol, market: args.market as never, interval: args.interval as never },
    order: { openTime: 'ASC' },
  });
  const candles = rows.map((r) => ({
    time: Number(r.openTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
  console.log(`\n加载 ${candles.length} 根 K 线`);

  // 逐 bar 算各信号 bias
  const biases = new Map<string, number[]>(); // +1 多 / -1 空 / 0 中立
  const closes: number[] = [];
  for (let i = args.warmup; i < candles.length; i += 1) {
    const window = candles.slice(Math.max(0, i - args.warmup + 1), i + 1);
    const ind = computeIndicators(window as never);
    const sigs = buildSignals(ind as never, window as never, { rsiMode: args.rsiMode });
    for (const s of sigs) {
      if (!biases.has(s.name)) biases.set(s.name, []);
      biases.get(s.name)!.push(s.bias === 'bullish' ? 1 : s.bias === 'bearish' ? -1 : 0);
    }
    closes.push(candles[i].close);
  }
  const n = closes.length;
  console.log(`有效样本 ${n} 根\n`);

  // 按权重方案算 score 序列
  const splitIdx = Math.floor(n * args.split);
  const results: { name: string; desc: string; ins: Perf; oos: Perf }[] = [];

  for (const scheme of SCHEMES) {
    const scores: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let num = 0;
      let den = 0;
      for (const [sig, w] of Object.entries(scheme.weights)) {
        const b = biases.get(sig)?.[i] ?? 0;
        // 与线上同口径：分子只算表态信号，分母含全部权重
        if (b !== 0) num += Math.sign(w) * b * Math.abs(w);
        den += Math.abs(w);
      }
      scores.push(den === 0 ? 0 : num / den);
    }
    results.push({
      name: scheme.name,
      desc: scheme.desc,
      ins: backtest(scores.slice(0, splitIdx), closes.slice(0, splitIdx), args.threshold, args.feeRate),
      oos: backtest(scores.slice(splitIdx), closes.slice(splitIdx), args.threshold, args.feeRate),
    });
  }

  const printBlock = (title: string, pick: (r: (typeof results)[0]) => Perf) => {
    console.log(`\n【${title}】`);
    console.log('─'.repeat(104));
    console.log(
      `${pad('方案', 16)}${pad('说明', 30)}${pad('总收益', 11, true)}${pad('交易', 8, true)}` +
        `${pad('胜率', 9, true)}${pad('夏普', 9, true)}${pad('最大回撤', 10, true)}`,
    );
    console.log('─'.repeat(104));
    for (const r of results) {
      const p = pick(r);
      console.log(
        `${pad(r.name, 16)}${pad(r.desc, 30)}${pad((p.totalReturn * 100).toFixed(2) + '%', 11, true)}` +
          `${pad(p.trades, 8, true)}${pad((p.winRate * 100).toFixed(1) + '%', 9, true)}` +
          `${pad(p.sharpe.toFixed(2), 9, true)}${pad((p.maxDrawdown * 100).toFixed(2) + '%', 10, true)}`,
      );
    }
    console.log('─'.repeat(104));
  };

  printBlock('样本内（前 70%，用于选方案）', (r) => r.ins);
  printBlock('样本外（后 30%，用于验证——这里好才算数）', (r) => r.oos);

  // ---------- 结论 ----------
  // 关键：**0 交易的方案必须排除**。不交易当然不亏不赚，
  // 若把它排第一，会得到"什么也不做就是最优策略"的荒谬结论
  // （上一版脚本正是踩了这个坑，把 0 交易的 ic_weighted 判为最优）。
  const noTrade = results.filter((r) => r.oos.trades === 0);
  if (noTrade.length) {
    console.log(
      `\n⚠️ 以下方案在样本外【0 交易】，已从排名中排除（不交易 ≠ 好策略）：` +
        noTrade.map((r) => r.name).join(', '),
    );
  }

  const tradable = results.filter((r) => r.oos.trades > 0);
  console.log('\n【样本外排名】（排除 0 交易方案；这才是决策依据）');
  const ranked = [...tradable].sort((a, b) => b.oos.totalReturn - a.oos.totalReturn);
  ranked.forEach((r, i) => {
    console.log(
      `  ${i + 1}. ${pad(r.name, 16)} 收益 ${(r.oos.totalReturn * 100).toFixed(2).padStart(8)}%  ` +
        `夏普 ${r.oos.sharpe.toFixed(2).padStart(6)}  回撤 ${(r.oos.maxDrawdown * 100).toFixed(2)}%  交易 ${r.oos.trades}`,
    );
  });

  console.log('\n【结论】');
  if (ranked.length === 0) {
    console.log('  ⚠️ 所有方案均无交易，无法对比（阈值可能过高）');
  } else {
    const base = results.find((r) => r.name === 'baseline')!;
    const bestOos = ranked[0];
    if (bestOos.name === 'baseline') {
      console.log('  当前权重（baseline）已是样本外最优，不建议改动。');
    } else {
      const delta = bestOos.oos.totalReturn - base.oos.totalReturn;
      console.log(
        `  样本外最优：${bestOos.name}（${bestOos.desc}），` +
          `较 baseline ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp`,
      );
    }
    // 一致性检查
    const tradableIns = results.filter((r) => r.ins.trades > 0);
    const bestIns = [...tradableIns].sort((a, b) => b.ins.totalReturn - a.ins.totalReturn)[0];
    if (bestIns && bestIns.name === bestOos.name) {
      console.log(`  ✅ 样本内排名一致（同为 ${bestIns.name}），结论较稳健。`);
    } else {
      console.log(
        `  ⚠️ 样本内最优 ${bestIns?.name ?? '（无）'} ≠ 样本外最优 ${bestOos.name}，` +
          `两窗不一致 → 可能是过拟合，不宜据此改权重。`,
      );
    }
    // 绝对收益检查：若最优方案仍巨亏，说明问题不在权重而在策略本身
    if (bestOos.oos.totalReturn < -0.1) {
      console.log(
        `  ⚠️ 最优方案样本外仍亏损 ${(bestOos.oos.totalReturn * 100).toFixed(2)}%` +
          ` → 问题可能不在权重配比，而在策略逻辑或成本结构本身。`,
      );
    }
  }

  await AppDataSource.destroy();
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('回测失败:', e);
  process.exit(1);
});
