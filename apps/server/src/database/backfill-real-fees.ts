/**
 * 一次性回填：用交易所真实手续费（/fapi/v1/userTrades）修正历史合约 Lot 的记账。
 *
 * 背景（2026-09-28）：合约下单/查询响应不含 commission，修复前结算按固定 0.10%/边估算，
 * 而真实 taker 仅约 0.04%。已平仓的 Lot 里 entryFeeUsdt/exitFeeUsdt 与 realizedPnl 被记错
 * （如 0.1 BTC 开仓记 8.34U，真实 3.33U），导致历史盈亏、篮子汇总、首页统计全部偏离交易所。
 * 新成交已走真实费；本脚本只负责把**存量**对齐。
 *
 * 用法：
 *   pnpm --filter server backfill:fees            # 干跑，只打印将要修改的清单，不写库
 *   pnpm --filter server backfill:fees -- --apply # 真正写库并刷新受影响篮子的汇总
 *
 * 幂等：真实费来自交易所，重复跑结果一致；取不到真实成交（端点无返回/非稳定币计价/
 * dry_run 单/超 30 天已过期）的 Lot 一律跳过、保持原值，绝不猜。
 */
import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';

// 脚本从 apps/server 运行，.env 在仓库根；多路径兜底加载
for (const p of [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]) {
  dotenv.config({ path: p });
}

// 注意：data-source.ts 在模块加载时就读 process.env 构造 DataSource，
// 而静态 import 会被 TS 提到 dotenv 之前——故它在 main() 里用动态 import，确保 .env 已加载。
import { PositionLotEntity } from './entities/position-lot.entity';
import { OrderEntity } from './entities/order.entity';
import { BasketEntity } from './entities/basket.entity';
import { BinanceFuturesAdapter } from '../exchanges/binance-futures.adapter';
import { settleLotPnl } from '@ai-trader/shared';

/** 手续费以这些资产计价时可直接当 USDT 用；非稳定币（如 BNB 抵扣）不猜、跳过 */
const STABLE_FEE_ASSETS = new Set(['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'DAI']);
const EPS = 1e-6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adapterFromEnv(): BinanceFuturesAdapter {
  const futKey = (process.env.BINANCE_FUTURES_API_KEY ?? '').trim();
  const futSec = (process.env.BINANCE_FUTURES_API_SECRET ?? '').trim();
  const key = futKey || (process.env.BINANCE_API_KEY ?? '').trim();
  const sec = futSec || (process.env.BINANCE_API_SECRET ?? '').trim();
  if (!key || !sec) throw new Error('缺少币安 API 密钥（BINANCE_FUTURES_API_KEY/SECRET 或 BINANCE_API_KEY/SECRET）');
  return new BinanceFuturesAdapter('demo', key, sec);
}

/** 查某交易所订单的真实手续费（USDT）与实测费率；取不到返回 null（调用方跳过） */
async function realCommission(
  adapter: BinanceFuturesAdapter,
  symbol: string,
  exchangeOrderId: string | null | undefined,
): Promise<{ fee: number; rate: number } | null> {
  // 只处理真实合约订单号（纯数字）；DRYF_ 前缀的 dry_run 单、null 一律跳过
  if (!exchangeOrderId || !/^\d+$/.test(exchangeOrderId)) return null;
  try {
    const trades = await adapter.getUserTrades({ symbol, orderId: exchangeOrderId });
    if (trades.length === 0) return null;
    let fee = 0;
    let quote = 0;
    for (const t of trades) {
      if (!(t.commission > 0)) continue;
      if (!STABLE_FEE_ASSETS.has(t.commissionAsset)) return null;
      fee += t.commission;
      quote += t.quoteQty;
    }
    if (fee <= 0) return null;
    return { fee: Number(fee.toFixed(8)), rate: quote > 0 ? fee / quote : 0 };
  } catch (err) {
    console.warn(`  userTrades 失败 symbol=${symbol} orderId=${exchangeOrderId}: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== 回填模式：APPLY（写库）===' : '=== 回填模式：DRY-RUN（仅预览，加 --apply 才写库）===');

  // dotenv 已在模块顶层执行完毕，此处再加载 data-source（其构造会读 DB 环境变量）
  const { AppDataSource } = await import('./data-source');
  await AppDataSource.initialize();
  const lotRepo = AppDataSource.getRepository(PositionLotEntity);
  const orderRepo = AppDataSource.getRepository(OrderEntity);
  const basketRepo = AppDataSource.getRepository(BasketEntity);
  const adapter = adapterFromEnv();

  const lots = await lotRepo.find({ where: { market: 'futures' }, order: { openedAt: 'ASC' } });
  console.log(`共 ${lots.length} 笔合约 Lot，逐笔核对真实手续费…`);

  const affectedBaskets = new Set<string>();
  let changed = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const lot of lots) {
    const openOrder = await orderRepo.findOne({ where: { id: lot.openOrderId } });
    const openInfo = await realCommission(adapter, lot.symbol, openOrder?.exchangeOrderId);
    if (openInfo == null) {
      skipped++;
      continue;
    }
    const realEntry = openInfo.fee;
    const entryRate = openInfo.rate;

    let realExit = lot.exitFeeUsdt == null ? null : Number(lot.exitFeeUsdt);
    let exitDerived = false;
    if (lot.status === 'CLOSED' && lot.exitPrice != null && Number(lot.quantity) > 0) {
      let resolved: { fee: number; rate: number } | null = null;
      if (lot.closeOrderId) {
        const closeOrder = await orderRepo.findOne({ where: { id: lot.closeOrderId } });
        resolved = await realCommission(adapter, lot.symbol, closeOrder?.exchangeOrderId);
      }
      if (resolved) {
        realExit = resolved.fee;
      } else if (entryRate > 0) {
        // 平仓单无法回查（历史 closeOrderId 缺失）：按同账户开仓实测费率 × 平仓名义 推导真实费，
        // 与交易所实际值仅差舍入（远优于旧的固定 0.1% 估算）。
        realExit = Number((Number(lot.exitPrice) * Number(lot.quantity) * entryRate).toFixed(8));
        exitDerived = true;
      }
    }

    const entryChanged = Math.abs(realEntry - Number(lot.entryFeeUsdt)) > EPS;
    const exitChanged =
      lot.status === 'CLOSED' &&
      realExit != null &&
      Math.abs(realExit - Number(lot.exitFeeUsdt ?? 0)) > EPS;
    if (!entryChanged && !exitChanged) {
      unchanged++;
      continue;
    }

    // 用修正后的费重算净盈亏（价格/成交量本身是对的，只有费错）
    let newRealized: number | null = null;
    let newReturnPct: number | null = null;
    if (lot.status === 'CLOSED' && lot.exitPrice != null) {
      const s = settleLotPnl({
        direction: lot.direction,
        quantity: Number(lot.quantity),
        entryPrice: Number(lot.entryPrice),
        exitPrice: Number(lot.exitPrice),
        entryFee: realEntry,
        exitFee: realExit ?? 0,
      });
      newRealized = s.realizedPnl;
      newReturnPct = s.returnPct;
    }

    console.log(
      `[${lot.status}] ${lot.direction} ${lot.symbol} ×${Number(lot.quantity)} @${Number(lot.entryPrice)} ` +
        `lot=${lot.id} basket=${lot.basketId ?? '-'}` +
        `\n   entryFee ${Number(lot.entryFeeUsdt).toFixed(6)} → ${realEntry.toFixed(6)}` +
        (exitChanged
          ? `\n   exitFee  ${Number(lot.exitFeeUsdt ?? 0).toFixed(6)} → ${(realExit ?? 0).toFixed(6)}${exitDerived ? '（按实测费率推导）' : ''}`
          : '') +
        (newRealized != null
          ? `\n   realized ${Number(lot.realizedPnl ?? 0).toFixed(6)} → ${newRealized.toFixed(6)}`
          : ''),
    );

    if (apply) {
      lot.entryFeeUsdt = realEntry;
      if (exitChanged && realExit != null) lot.exitFeeUsdt = realExit;
      if (newRealized != null) lot.realizedPnl = newRealized;
      if (newReturnPct != null) lot.returnPct = newReturnPct;
      await lotRepo.save(lot);
      if (lot.basketId) affectedBaskets.add(lot.basketId);
    }
    changed++;
    await sleep(120); // 温和限速，避免触发 userTrades 频控
  }

  // 刷新受影响篮子的汇总（只重算受费用影响的三项，不动状态/时间，避免副作用）
  if (apply && affectedBaskets.size > 0) {
    console.log(`\n刷新 ${affectedBaskets.size} 个篮子汇总…`);
    for (const basketId of affectedBaskets) {
      const bLots = await lotRepo.find({ where: { basketId } });
      const num = (v: unknown) => Number(v ?? 0);
      const entryNotional = bLots.reduce((a, l) => a + num(l.entryPrice) * num(l.quantity), 0);
      const closed = bLots.filter((l) => l.status === 'CLOSED');
      const realized = closed.reduce((a, l) => a + num(l.realizedPnl), 0);
      const fee =
        bLots.reduce((a, l) => a + num(l.entryFeeUsdt), 0) +
        closed.reduce((a, l) => a + num(l.exitFeeUsdt), 0);
      const basket = await basketRepo.findOne({ where: { id: basketId } });
      if (!basket) continue;
      basket.feeTotal = fee;
      basket.realizedPnl = realized;
      basket.returnPct = entryNotional > 0 ? Number((realized / entryNotional).toFixed(8)) : null;
      await basketRepo.save(basket);
      console.log(`  篮子 ${basketId} feeTotal=${fee.toFixed(4)} realizedPnl=${realized.toFixed(4)}`);
    }
  }

  console.log(
    `\n完成：核对 ${lots.length} 笔，需修正 ${changed} 笔，已一致 ${unchanged} 笔，跳过（取不到真实费）${skipped} 笔。` +
      (apply ? ' 已写库。' : ' （干跑，未写库；加 --apply 执行）'),
  );

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error('回填失败：', err);
  process.exit(1);
});
