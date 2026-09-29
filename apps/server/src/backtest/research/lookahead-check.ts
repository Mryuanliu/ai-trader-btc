import {
  type BacktestConfig,
  type Candle,
  type LookaheadCheckResult,
  type BacktestTrade,
} from '@ai-trader/shared';
import { runBacktestOnCandles } from '../backtest-runner';
import { createStrategy } from '../strategy-registry';

/** 决策签名（只取会随「看到的数据」变化的字段，忽略报告时间戳等） */
function signature(trades: BacktestTrade[]): string[] {
  return trades.map(
    (t) => `${t.time}|${t.kind}|${t.side}|${t.direction}|${t.price}|${t.quantity}`,
  );
}

/**
 * 前视 / 纯函数性自检。
 *
 * runner 每根 bar 只把 `candles[0..i]` 交给策略，因此一个「干净」策略的决策序列必须满足：
 * 1. **确定性**：同一份数据跑两遍，逐笔决策完全一致（抓 Math.random / 未复位实例状态）。
 * 2. **无未来依赖**：截断到第 P 根的「前缀回放」，其全部决策与「全样本回放」里时间 ≤ P 的
 *    决策逐笔相同（抓 `Date.now()` 墙钟、绝对下标越界、跨 bar 缓存未来信息等）。
 *
 * 任一不满足即报警——这正是曾经 `Date.now()` 冷却 bug 会让回测「只成交一笔」的那类问题。
 */
export async function lookaheadCheck(
  strategyName: string,
  base: BacktestConfig,
  candles: Candle[],
  samplePoints = 4,
): Promise<LookaheadCheckResult> {
  const messages: string[] = [];
  const warmup = base.warmupBars;
  if (candles.length <= warmup + 2) {
    return { ok: false, messages: ['数据不足以做前视自检（需 > warmup+2 根）'] };
  }

  const full = await runBacktestOnCandles(createStrategy(strategyName), { ...base }, candles);
  const fullSig = signature(full.report.trades);

  // 1. 确定性：再跑一遍，逐笔应一致
  const full2 = await runBacktestOnCandles(createStrategy(strategyName), { ...base }, candles);
  const full2Sig = signature(full2.report.trades);
  if (JSON.stringify(fullSig) !== JSON.stringify(full2Sig)) {
    messages.push('确定性失败：同一数据两次运行的决策序列不一致（疑似用了随机数或未复位的实例状态）');
  }

  // 2. 无未来依赖：在决策区均匀取若干截断点，比对前缀决策与全样本对应段
  const lastBar = candles.length - 1;
  const cutStart = warmup + 1;
  const step = Math.max(1, Math.floor((lastBar - cutStart) / (samplePoints + 1)));
  for (let p = cutStart + step; p <= lastBar; p += step) {
    const cutoffTime = candles[p].time;
    const prefix = await runBacktestOnCandles(
      createStrategy(strategyName),
      { ...base },
      candles.slice(0, p + 1),
    );
    const prefixSig = signature(prefix.report.trades);
    // 截断到第 p 根：成交时刻 <= p 时间的每一笔应与全样本对应段逐笔相同
    // （第 p 根的决策要到 p+1 开盘才成交，两边都不计入）
    const fullUpToCutoff = signature(
      full.report.trades.filter((t) => t.time <= cutoffTime),
    );
    if (JSON.stringify(prefixSig) !== JSON.stringify(fullUpToCutoff)) {
      messages.push(
        `前视/墙钟失败：截断到第 ${p} 根（${new Date(cutoffTime).toISOString()}）的决策与全样本不一致`,
      );
      break;
    }
  }

  return { ok: messages.length === 0, messages };
}
