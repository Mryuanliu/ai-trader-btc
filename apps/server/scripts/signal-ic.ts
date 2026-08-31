/**
 * C1 · 信号 IC 分析
 *
 * 回答：六个信号里，哪些真的有预测力？
 *
 * 方法：对每个信号，用滚动窗口计算它与未来收益的 Spearman 秩相关（IC 序列），
 * 再对 IC 序列做 HAC（Newey-West）稳健 t 检验，并看分位收益是否单调。
 * **三票通过**（IC 显著 + t 显著 + 分位单调）才算有效信号。
 *
 * 为什么必须做：六个信号的权重是拍脑袋定的。若某信号 IC≈0，
 * 它只在贡献噪声并稀释有效信号——这类信号应降权或剔除。
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/signal-ic.ts
 *   npx ts-node -r tsconfig-paths/register scripts/signal-ic.ts --interval=15m --horizon=10
 *   npx ts-node -r tsconfig-paths/register scripts/signal-ic.ts --rsiMode=trend
 */
import { AppDataSource } from '../src/database/data-source';
import { MarketCandleEntity } from '../src/database/entities/market-candle.entity';
import {
  analyzeSignal,
  forwardReturns,
  rollingIcSeries,
  spearman,
  type SignalIcResult,
} from '@ai-trader/shared';
import { buildSignals, computeIndicators } from '@ai-trader/shared';
import type { RsiMode } from '@ai-trader/shared';

interface Args {
  market: string;
  symbol: string;
  interval: string;
  /** 指标预热窗口 */
  warmup: number;
  /** 预测周期：多少根 bar 之后的收益 */
  horizon: number;
  /** 滚动 IC 窗口大小 */
  icWindow: number;
  /** IC 采样步长（调大可加速） */
  step: number;
  /** RSI 语义 */
  rsiMode: RsiMode;
  /** 收益口径 */
  retMode: 'simple' | 'log';
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
    horizon: Number(get('horizon', '12')), // 5m × 12 = 1 小时
    icWindow: Number(get('icWindow', '300')),
    step: Number(get('step', '5')),
    rsiMode: get('rsiMode', 'reversion') === 'trend' ? 'trend' : 'reversion',
    retMode: get('retMode', 'simple') === 'log' ? 'log' : 'simple',
  };
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

/** 信号值：把三档 bias 转成有符号权重（与该信号对综合分的贡献一致） */
function signedValue(bias: 'bullish' | 'bearish' | 'neutral', weight: number): number {
  if (bias === 'neutral') return 0;
  return bias === 'bullish' ? weight : -weight;
}

async function main() {
  const args = parseArgs();
  console.log('═'.repeat(96));
  console.log('C1 · 信号 IC 分析（Spearman + HAC t-stat + 分位收益）');
  console.log(
    `市场 ${args.market} · ${args.symbol} · ${args.interval} · 预热 ${args.warmup} · ` +
      `预测周期 ${args.horizon} 根 · IC 窗口 ${args.icWindow} · RSI ${args.rsiMode}`,
  );
  console.log('═'.repeat(96));

  await AppDataSource.initialize();
  const rows = await AppDataSource.getRepository(MarketCandleEntity).find({
    where: { symbol: args.symbol, market: args.market as never, interval: args.interval as never },
    order: { openTime: 'ASC' },
  });
  console.log(`\n加载 ${rows.length} 根 K 线`);

  const candles = rows.map((r) => ({
    time: Number(r.openTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  if (candles.length < args.warmup + args.icWindow + args.horizon + 10) {
    console.error('❌ K 线不足，无法分析');
    await AppDataSource.destroy();
    process.exit(1);
  }

  // 未来收益（按整段 closes 算，索引对齐 candles）
  const closes = candles.map((c) => c.close);
  const fwd = forwardReturns(closes, args.horizon, args.retMode);

  // 逐 bar 计算各信号值
  console.log(`滚窗计算信号（${candles.length - args.warmup} 次）...`);
  const started = Date.now();
  const signalValues = new Map<string, number[]>();
  const times: number[] = [];
  const fwdAligned: number[] = [];

  for (let i = args.warmup; i < candles.length; i += 1) {
    // 未来收益未知（超出数据末尾）的位置跳过，避免使用不可预知的数据
    if (Number.isNaN(fwd[i])) continue;
    const window = candles.slice(Math.max(0, i - args.warmup + 1), i + 1);
    const ind = computeIndicators(window as never);
    const sigs = buildSignals(ind as never, window as never, { rsiMode: args.rsiMode });

    for (const s of sigs) {
      if (!signalValues.has(s.name)) signalValues.set(s.name, []);
      signalValues.get(s.name)!.push(signedValue(s.bias, s.weight));
    }
    times.push(candles[i].time);
    fwdAligned.push(fwd[i]);
  }
  console.log(`完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，有效样本 ${times.length}`);

  // ---------- 整体 IC（信号 vs 未来收益的全样本相关） ----------
  console.log('\n【全样本 IC】信号值与未来收益的 Spearman 相关（单期）');
  console.log('─'.repeat(96));
  console.log(
    `${pad('信号', 14)}${pad('样本数', 10, true)}${pad('整体IC', 12, true)}` +
      `${pad('说明', 40)}`,
  );
  console.log('─'.repeat(96));
  const overall: Record<string, number> = {};
  for (const [name, vals] of signalValues) {
    const ic = spearman(vals, fwdAligned);
    overall[name] = ic;
    const note =
      Math.abs(ic) < 0.02 ? '≈0 无预测力（纯噪声）' : ic > 0 ? '正向：值越大未来收益越高' : '负向：值越大未来收益越低';
    console.log(`${pad(name, 14)}${pad(vals.length, 10, true)}${pad(ic.toFixed(4), 12, true)}${pad(note, 40)}`);
  }

  // ---------- 滚动 IC + HAC 检验 ----------
  console.log('\n【滚动 IC + HAC 稳健检验】—— 三票通过才算有效');
  console.log('判据：|IC| >= 0.02 且 |HAC t| >= 2 且 分位收益单调');
  console.log('─'.repeat(96));
  console.log(
    `${pad('信号', 14)}${pad('IC均值', 10, true)}${pad('IC标准差', 11, true)}` +
      `${pad('IR', 8, true)}${pad('HAC t', 10, true)}${pad('Q5-Q1', 11, true)}${pad('单调', 7)}${pad('判定', 8)}`,
  );
  console.log('─'.repeat(96));

  const results: SignalIcResult[] = [];
  for (const [name, vals] of signalValues) {
    const icSeries = rollingIcSeries(vals, fwdAligned, args.icWindow, args.step);
    const r = analyzeSignal(name, icSeries);
    results.push(r);
    console.log(
      `${pad(name, 14)}${pad(r.ic.toFixed(4), 10, true)}${pad(r.icStd.toFixed(4), 11, true)}` +
        `${pad(r.ir.toFixed(3), 8, true)}${pad(r.tStat.toFixed(2), 10, true)}` +
        `${pad(r.q5MinusQ1.toFixed(4), 11, true)}${pad(r.monotonic ? '是' : '否', 7)}` +
        `${pad(r.significant ? '✅ 有效' : '❌ 无效', 8)}`,
    );
  }
  console.log('─'.repeat(96));

  // ---------- 结论与权重建议 ----------
  console.log('\n【结论】');
  const valid = results.filter((r) => r.significant);
  const invalid = results.filter((r) => !r.significant);
  console.log(`  有效信号 ${valid.length} 个：${valid.map((r) => r.name).join(', ') || '（无）'}`);
  console.log(`  无效信号 ${invalid.length} 个：${invalid.map((r) => r.name).join(', ') || '（无）'}`);

  if (invalid.length > 0) {
    console.log('\n  ⚠️ 以下信号未通过检验，当前却在参与打分（占分母、稀释有效信号）：');
    for (const r of invalid) {
      console.log(
        `     ${pad(r.name, 14)} IC=${r.ic.toFixed(4)} t=${r.tStat.toFixed(2)}` +
          ` → 建议降权或剔除（当前权重仍计入分母）`,
      );
    }
  }

  console.log('\n【IC 加权权重建议】（|IC| 归一化，无效信号置 0）');
  const absSum = results.reduce((acc, r) => acc + Math.max(0, r.significant ? Math.abs(r.ic) : 0), 0);
  if (absSum > 0) {
    for (const r of results) {
      const w = r.significant ? Math.abs(r.ic) / absSum : 0;
      console.log(`  ${pad(r.name, 14)} ${(w * 100).toFixed(1)}%`);
    }
    console.log('\n  注：此为统计建议，需经 C2 样本外回测验证后再采用（权重改动会改变已校准阈值）');
  }

  await AppDataSource.destroy();
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('分析失败:', e);
  process.exit(1);
});
