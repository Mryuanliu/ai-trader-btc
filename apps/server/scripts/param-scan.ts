/**
 * 止血 · 参数扫描：寻找「毛收益 vs 交易成本」的平衡点
 *
 * 背景：C2 发现线上策略毛收益为正（feeRate=0 时 +2.31%，夏普 2.23），
 * 但计入 0.1% 双边手续费后变成 -18.23%。而线上 mean_reversion @1m 简化回测
 * 净收益 -45.54%（238 次交易、胜率 69.3%）——**胜率高却被成本磨死**。
 *
 * 目标：找到能大幅降低交易频率、同时保住毛收益的参数组合。
 *
 * 方法：
 * - 指标只算一次并缓存（与策略参数无关），再遍历参数组合，避免 O(组合数×根数) 的重算
 * - 同时输出 feeRate=0（毛收益）与 feeRate=0.001（净收益），两者对比才能看清成本影响
 * - 样本内/样本外对照，只在样本外也好的组合才可采信
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/param-scan.ts
 *   npx ts-node -r tsconfig-paths/register scripts/param-scan.ts --interval=1m --limit=40000
 */
import { AppDataSource } from '../src/database/data-source';
import { MarketCandleEntity } from '../src/database/entities/market-candle.entity';
import { computeIndicators, strategyRegistry } from '@ai-trader/shared';
import type { IndicatorSnapshot } from '@ai-trader/shared';
import type { Candle } from '@ai-trader/shared';

interface Args {
  market: string;
  symbol: string;
  interval: string;
  warmup: number;
  /** 最多使用多少根 K 线（取最近的） */
  limit: number;
  split: number;
  feeRate: number;
}

function parseArgs(): Args {
  const get = (k: string, d: string) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : d;
  };
  return {
    market: get('market', 'spot'),
    symbol: get('symbol', 'BTCUSDT'),
    interval: get('interval', '1m'),
    warmup: Number(get('warmup', '300')),
    limit: Number(get('limit', '60000')),
    split: Number(get('split', '0.7')),
    feeRate: Number(get('feeRate', '0.001')),
  };
}

interface Perf {
  totalReturn: number;
  trades: number;
  winRate: number;
  /** 毛收益（零手续费），用于判断是否"信号本身有价值" */
  grossReturn: number;
  maxDrawdown: number;
}

/**
 * 简化回测：BUY 开多、SELL 平仓（单向做多，与现货一致），带最小持仓限频。
 *
 * 注意：不追求精确绩效（未含滑点、minNotional、分批建仓），
 * 目的是**横向对比参数组合的相对优劣**并定位降频的收益拐点。
 */
function backtest(
  actions: ('BUY' | 'SELL' | 'HOLD')[],
  closes: number[],
  feeRate: number,
  minHoldBars: number,
): Perf {
  const run = (fee: number): { ret: number; trades: number; wins: number; dd: number } => {
    let pos: 0 | 1 = 0;
    let entry = 0;
    let entryIdx = -1e9;
    let eq = 1;
    let peak = 1;
    let dd = 0;
    let trades = 0;
    let wins = 0;
    for (let i = 0; i < actions.length; i += 1) {
      const px = closes[i];
      let want: 0 | 1 = actions[i] === 'BUY' ? 1 : actions[i] === 'SELL' ? 0 : pos;
      // 限频：持仓未满 minHoldBars 不允许平仓（抑制过度交易）
      if (pos === 1 && i - entryIdx < minHoldBars) want = 1;

      if (want !== pos) {
        if (pos === 1) {
          const pnl = (px - entry) / entry;
          eq *= 1 + pnl - fee;
          trades += 1;
          if (pnl > 0) wins += 1;
        }
        if (want === 1) {
          entry = px;
          entryIdx = i;
          eq *= 1 - fee;
        }
        pos = want;
      }
      peak = Math.max(peak, eq);
      dd = Math.max(dd, (peak - eq) / peak);
    }
    if (pos === 1) {
      const px = closes[closes.length - 1];
      eq *= 1 + (px - entry) / entry - fee;
    }
    return { ret: eq - 1, trades, wins, dd };
  };

  const net = run(feeRate);
  const gross = run(0);
  return {
    totalReturn: net.ret,
    trades: net.trades,
    winRate: net.trades === 0 ? 0 : net.wins / net.trades,
    grossReturn: gross.ret,
    maxDrawdown: net.dd,
  };
}

function pad(s: string | number, n: number, right = false): string {
  return right ? String(s).padStart(n) : String(s).padEnd(n);
}

async function main() {
  const args = parseArgs();
  console.log('═'.repeat(112));
  console.log('止血 · 参数扫描（毛收益 vs 成本平衡点）');
  console.log(
    `${args.symbol} ${args.interval} · 最多 ${args.limit} 根 · 手续费 ${(args.feeRate * 100).toFixed(2)}% · ` +
      `切分 ${(args.split * 100).toFixed(0)}%`,
  );
  console.log('═'.repeat(112));

  await AppDataSource.initialize();
  const all = await AppDataSource.getRepository(MarketCandleEntity).find({
    where: { symbol: args.symbol, market: args.market as never, interval: args.interval as never },
    order: { openTime: 'ASC' },
  });
  // 取最近 limit 根（保持时间连续）
  const rows = all.slice(Math.max(0, all.length - args.limit));
  const candles: Candle[] = rows.map((r) => ({
    time: Number(r.openTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
  console.log(`\n加载 ${all.length} 根，取最近 ${candles.length} 根`);

  if (candles.length < args.warmup + 100) {
    console.error('❌ K 线不足');
    await AppDataSource.destroy();
    process.exit(1);
  }

  // ---------- 指标只算一次并缓存 ----------
  console.log(`计算指标（${candles.length - args.warmup} 次，仅此一次）...`);
  const t0 = Date.now();
  const inds: IndicatorSnapshot[] = [];
  const closes: number[] = [];
  for (let i = args.warmup; i < candles.length; i += 1) {
    const win = candles.slice(i - args.warmup + 1, i + 1);
    inds.push(computeIndicators(win as never));
    closes.push(candles[i].close);
  }
  console.log(`完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，有效样本 ${closes.length}`);

  const n = closes.length;
  const splitIdx = Math.floor(n * args.split);
  const strat = strategyRegistry.get('mean_reversion')!;

  // ---------- 参数网格 ----------
  const bandThresholds = [0.02, 0.05, 0.1, 0.15, 0.2];
  const rsiThresholds = [20, 25, 30, 35, 40];
  const holdBars = [12, 30, 60, 120];

  interface Row {
    band: number;
    rsi: number;
    hold: number;
    ins: Perf;
    oos: Perf;
  }
  const results: Row[] = [];

  console.log(`\n遍历 ${bandThresholds.length * rsiThresholds.length * holdBars.length} 组参数...`);
  for (const band of bandThresholds) {
    for (const rsi of rsiThresholds) {
      // 决策只依赖指标，与 hold 无关 → 先算一次决策序列，再套不同限频
      const actions: ('BUY' | 'SELL' | 'HOLD')[] = [];
      for (let i = 0; i < n; i += 1) {
        const out = strat.evaluate({
          symbol: args.symbol,
          timeframe: args.interval as never,
          candles: [] as never,
          indicators: inds[i] as never,
          signals: [] as never,
          indicatorScore: 0,
          ticker: {} as never,
          position: null,
          account: { quoteFree: 1000, baseFree: 0 },
          params: {
            bandPosLow: band,
            bandPosHigh: 1 - band,
            rsiOversold: rsi,
            rsiOverbought: 100 - rsi,
          },
        });
        actions.push(out.action);
      }
      for (const hold of holdBars) {
        results.push({
          band,
          rsi,
          hold,
          ins: backtest(actions.slice(0, splitIdx), closes.slice(0, splitIdx), args.feeRate, hold),
          oos: backtest(actions.slice(splitIdx), closes.slice(splitIdx), args.feeRate, hold),
        });
      }
    }
  }

  // ---------- 基线（当前线上参数）----------
  const baseActions: ('BUY' | 'SELL' | 'HOLD')[] = [];
  for (let i = 0; i < n; i += 1) {
    const out = strat.evaluate({
      symbol: args.symbol,
      timeframe: args.interval as never,
      candles: [] as never,
      indicators: inds[i] as never,
      signals: [] as never,
      indicatorScore: 0,
      ticker: {} as never,
      position: null,
      account: { quoteFree: 1000, baseFree: 0 },
      params: {}, // 默认：bandPos 0.05/0.95、RSI 30/70
    });
    baseActions.push(out.action);
  }

  console.log('\n【基线：当前线上参数】bandPos 0.05/0.95 · RSI 30/70');
  console.log('─'.repeat(112));
  console.log(
    `${pad('持仓限频', 12)}${pad('区间', 12)}${pad('净收益', 12, true)}${pad('毛收益', 12, true)}` +
      `${pad('交易', 8, true)}${pad('胜率', 9, true)}${pad('最大回撤', 10, true)}`,
  );
  console.log('─'.repeat(112));
  for (const hold of holdBars) {
    const ins = backtest(baseActions.slice(0, splitIdx), closes.slice(0, splitIdx), args.feeRate, hold);
    const oos = backtest(baseActions.slice(splitIdx), closes.slice(splitIdx), args.feeRate, hold);
    console.log(
      `${pad(hold + ' 根', 12)}${pad('样本内', 12)}${pad((ins.totalReturn * 100).toFixed(2) + '%', 12, true)}` +
        `${pad((ins.grossReturn * 100).toFixed(2) + '%', 12, true)}${pad(ins.trades, 8, true)}` +
        `${pad((ins.winRate * 100).toFixed(1) + '%', 9, true)}${pad((ins.maxDrawdown * 100).toFixed(2) + '%', 10, true)}`,
    );
    console.log(
      `${pad('', 12)}${pad('样本外', 12)}${pad((oos.totalReturn * 100).toFixed(2) + '%', 12, true)}` +
        `${pad((oos.grossReturn * 100).toFixed(2) + '%', 12, true)}${pad(oos.trades, 8, true)}` +
        `${pad((oos.winRate * 100).toFixed(1) + '%', 9, true)}${pad((oos.maxDrawdown * 100).toFixed(2) + '%', 10, true)}`,
    );
  }

  // ---------- 最优组合（样本外排名）----------
  const tradable = results.filter((r) => r.oos.trades > 0);
  const ranked = [...tradable].sort((a, b) => b.oos.totalReturn - a.oos.totalReturn);

  console.log('\n【样本外 Top 15】（排除 0 交易；净收益才是决策依据）');
  console.log('─'.repeat(112));
  console.log(
    `${pad('bandPos', 10)}${pad('RSI', 8)}${pad('限频', 8)}${pad('净收益', 12, true)}` +
      `${pad('毛收益', 12, true)}${pad('交易', 8, true)}${pad('胜率', 9, true)}${pad('回撤', 10, true)}` +
      `${pad('样本内净', 12, true)}`,
  );
  console.log('─'.repeat(112));
  for (const r of ranked.slice(0, 15)) {
    console.log(
      `${pad(r.band, 10)}${pad(r.rsi, 8)}${pad(r.hold, 8)}` +
        `${pad((r.oos.totalReturn * 100).toFixed(2) + '%', 12, true)}` +
        `${pad((r.oos.grossReturn * 100).toFixed(2) + '%', 12, true)}` +
        `${pad(r.oos.trades, 8, true)}${pad((r.oos.winRate * 100).toFixed(1) + '%', 9, true)}` +
        `${pad((r.oos.maxDrawdown * 100).toFixed(2) + '%', 10, true)}` +
        `${pad((r.ins.totalReturn * 100).toFixed(2) + '%', 12, true)}`,
    );
  }
  console.log('─'.repeat(112));

  // ---------- 结论 ----------
  console.log('\n【结论】');
  const baseOos = backtest(baseActions.slice(splitIdx), closes.slice(splitIdx), args.feeRate, 12);
  if (ranked.length === 0) {
    console.log('  ⚠️ 所有组合在样本外均无交易，需放宽阈值');
  } else {
    const best = ranked[0];
    console.log(`  基线（bandPos 0.05 / RSI 30 / 限频 12）样本外：${(baseOos.totalReturn * 100).toFixed(2)}%`);
    console.log(
      `  最优（bandPos ${best.band} / RSI ${best.rsi} / 限频 ${best.hold}）样本外：` +
        `${(best.oos.totalReturn * 100).toFixed(2)}%  样本内：${(best.ins.totalReturn * 100).toFixed(2)}%`,
    );
    const delta = best.oos.totalReturn - baseOos.totalReturn;
    console.log(`  较基线 ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}pp`);

    // 稳健性：样本内也应为正，否则可能只是这段行情的巧合
    if (best.ins.totalReturn > 0 && best.oos.totalReturn > 0) {
      console.log('  ✅ 样本内与样本外均为正 → 结论较稳健，可采用');
    } else if (best.oos.totalReturn > 0) {
      console.log('  ⚠️ 仅样本外为正、样本内为负 → 稳健性不足，谨慎采用');
    } else {
      console.log(
        '  ⚠️ 最优组合样本外仍为负 → 说明该策略在当前成本结构下难以盈利，' +
          '应考虑更大幅降频、更换策略，或核实手续费率是否可优化',
      );
    }

    // 降频效果：对比最优与基线的交易次数
    console.log(
      `\n  降频效果：基线 ${baseOos.trades} 次 → 最优 ${best.oos.trades} 次` +
        `（${baseOos.trades > 0 ? ((1 - best.oos.trades / baseOos.trades) * 100).toFixed(0) : 0}% 降幅）`,
    );
    console.log(
      `  成本对比：基线 毛${(baseOos.grossReturn * 100).toFixed(2)}% → 净${(baseOos.totalReturn * 100).toFixed(2)}%` +
        ` | 最优 毛${(best.oos.grossReturn * 100).toFixed(2)}% → 净${(best.oos.totalReturn * 100).toFixed(2)}%`,
    );
  }

  await AppDataSource.destroy();
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('扫描失败:', e);
  process.exit(1);
});
