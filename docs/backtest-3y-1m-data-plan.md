# 回测台收尾：3 年 1m 粒度历史数据方案

> 状态：待批准。批准后按「落地步骤」执行。本方案只解决**数据管线 + 回测粒度与实盘对齐**，不含 engine_v2（L2/队列/冲击模型），后者明确 out-of-scope。

## 1. 决策依据（已核实，非臆想）

- **实盘粒度**：`strategy-runner.buildContextFor` 第 624 行 `getCandles(symbol, '1m', …)` —— 平台喂给策略的恒为 **1 分钟 K 线**；`tick()` 由实时价格事件驱动、`MIN_TICK_INTERVAL_MS=800` 节流 → 策略约**每秒**基于 1m 线做一次决策。
- **回测粒度**：`runBacktest` 按 `config.interval` 载入 K 线，`runBacktestOnCandles` **逐根 bar** 驱动 `onTick`（next-open 撮合）。若 `interval=4h` 则每天仅 6 次 onTick，与实盘每秒看 1m **严重错配**（4h 线中间的破位/止损全被抹平）。
- **既有隐患**：donchian `DEFAULT_PARAMS` 注释「4h×~2y walk-forward 调优」——即用 4h 粗数据调出的参数投到 1m 实盘，参数未必可迁移。本方案顺带纠正此错配。
- **数据源**：`data.binance.vision/data/futures/um/monthly/klines/{SYM}/{TF}/{SYM}-{TF}-{YYYY-MM}.zip`，实测 1m 单月 1.8MB/43200 行；`1m` 为合法 `Timeframe`（`TIMEFRAMES`、`TIMEFRAME_MS['1m']=60_000`）。
- **落库点**：`market_candles` 表已存在，唯一索引 `[symbol,market,interval,openTime]`，天然支持幂等 `orIgnore` 续传；**缺 `volume` 列**（CSV 有量）。

## 2. 目标 / 非目标

**目标**
- G1：把 3 年（滚动窗口 `now-3y → now-1d`）BTCUSDT **合约 1m K 线**全量拉入 `market_candles`，离线、可续传、幂等。
- G2：让向量化回测能**从 DB 直接读 1m**（免联网），`interval=1m` 即与实盘同粒度回放。
- G3：以 1m 重跑 donchian / mean_reversion / trend_following 的 research（walk-forward+CPCV+DSR），产出与实盘对齐的闸门结论。

**非目标（明确不做）**
- 不做 engine_v2（L2 队列/VWAP 吃深度/冲击模型/latency）。
- 不改实盘交易主链路。
- aggTrades 逐笔仍属可选最重层，本方案不依赖。

## 3. 数据流

```
data.binance.vision 月 zip (1m×36)
   → pullKlinesArchive: 下载→跳表头→解析CSV→orIgnore 写 market_candles(market='futures',interval='1m')
   → loadHistoricalCandles 新增 DB 源 (file > cache > DB > net)
   → runBacktest(interval='1m') 逐分钟 onTick（与实盘对齐）
   → research/walk-forward 切片 → 闸门报告
```

## 4. 改动清单（逐文件、决策完整）

### 4.1 `MarketCandleEntity` 增 `volume` 列
- 文件：`apps/server/src/database/entities/market-candle.entity.ts`
- 在 `close` 后加：`@Column({ type: 'float8', default: 0 }) volume: number;`
- 迁移：新增 `apps/server/src/database/migrations/17xxxxxxxxx-AddCandleVolume.ts`
  - `ALTER TABLE market_candles ADD COLUMN IF NOT EXISTS volume float8 NOT NULL DEFAULT 0;`（down 为 drop column）
- 注：dev 环境 `DB_SYNCHRONIZE` 会自动建列，迁移仅为生产可复现。

### 4.2 K 线归档拉取器（核心）
- 新文件：`apps/server/src/backtest/pull/klines-archive.ts`
- 导出 `pullKlinesArchive(ds, symbol, interval, from, to, opts): Promise<KlinesArchiveResult>`
  - `KlinesArchiveResult = { rows: number; months: string[]; failedMonths: string[] }`
  - 复用 `archive-download.ts` 的健壮模式：
    - `probeKlinesArchiveReachable()`：预检（HEAD 一个 1970 占位，失败即快速抛「代理不可达」而非逐月空耗）。
    - 逐月 URL `.../monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${YYYY-MM}.zip`；`AbortSignal.timeout` 墙钟硬超时 + 重试 ≤2。
    - **单月 404/失败只记入 `failedMonths`，不中断**（代理抖动可重跑续传）。
    - `decompressZip`（复用 archive-download 的解压工具）→ CSV：跳过首行 header；列序 `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore`。
    - 映射：`{ symbol, market:'futures', interval, openTime:Number(c[0]), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }`；`close_time` 落在 `[from,to]` 外的月边缘行按 openTime 过滤保留区间内。
    - 入库：`repo.createQueryBuilder().insert().orIgnore().values(batch)`，`BATCH_SIZE=5000`（1m 单月 43200 行，远低于 PG 65535 参数上限：5000×9≈45k）。
  - `onProgress(month, rows, cumulative)` 回调供 CLI 打印。

### 4.3 `loadHistoricalCandles` 增 DB 源
- 文件：`apps/server/src/backtest/historical-feed.ts`
- 优先级改为 **file > cache > DB > 联网**：`if (cacheDir 命中) return …` 之后、`fetchFuturesKlines` 之前，插入
  ```ts
  if (args.dataSource) {
    const fromDb = await loadCandlesFromDb(args.dataSource, symbol, interval, from, to);
    if (fromDb.length > 0) return fromDb;   // 有数据即返回，空则回退联网
  }
  ```
- 新增 `loadCandlesFromDb(ds, symbol, interval, from, to)`：`SELECT openTime,open,high,low,close,volume FROM market_candles WHERE symbol=? AND market='futures' AND interval=? AND openTime BETWEEN from AND to ORDER BY openTime ASC` → `Candle[]`。
- `BacktestConfig` 增可选 `dataSource?: DataSource`（见 4.5）。CLI/service 注入 AppDataSource。

### 4.4 拉取 CLI 接入
- 文件：`apps/server/src/backtest/pull/cli.ts`
- 新增分支：`if (only.includes('klines') || only.includes('klines-archive'))`
  - `const interval = (args.interval ?? '1m') as Timeframe;`
  - 预检 → `pullKlinesArchive(...)` → 打印 `klines(archive ${interval}): upsert ${rows} / ${months.length} 月`+`failedMonths`。
  - 质检段 `requireAggTrades` 不受影响（klines 不要求 aggTrades）。
- 用法示例：
  ```bash
  pnpm --filter @ai-trader/server pull-history -- \
    --symbol BTCUSDT --interval 1m --only klines-archive \
    --from "2023-10-01" --to "2026-10-01"
  ```

### 4.5 回测/研究以 1m 跑 + 成本护栏
- `BacktestConfig` 增 `dataSource?: DataSource`（`import type { DataSource } from 'typeorm'`）；`runBacktest` 透传给 `loadHistoricalCandles`。
- **粒度策略（关键，防算力爆炸）**：3 年 1m ≈ **1.57M 根**，单次全量 onTick 回放约数十秒、内存对象 ~150–300MB（可接受）。但 **sweep 在 1m×1.57M×数百组 = 数小时，不可取**。因此：
  - **粗筛 sweep 保持现有较粗 interval**（如 15m/1h）快速缩小参数空间；
  - **定稿 research / walk-forward 才切 `interval=1m`** 从 DB 读（与实盘对齐、防过拟合结论可信）。
  - CLI 文档写明：`--interval 1m --mode research` 为定稿档，`--mode sweep` 建议粗周期。

## 5. 落地步骤（执行顺序）

1. 4.1 迁移 + 实体列 → 重启（DB_SYNCHRONIZE）或跑 `migration:run` 建 `volume` 列。
2. 单月冒烟：`--only klines-archive --interval 1m --from 2026-09-01 --to 2026-10-01` → 校验入库 43200 行、`SELECT` 抽样对得上币安。
3. 全量 3 年：跑 G1 命令（36 月，~65MB）。代理抖动导致 failedMonths → **重跑同命令续传**（orIgnore 幂等）。
4. 4.2/4.3/4.5 代码合入后，`--interval 1m --mode research` 对三策略出 1m 闸门报告。
5. 回归：`vitest`（新增 `klines-archive.spec.ts`：CSV 解析/跳表头/区间过滤/failedMonths；`historical-feed` DB 源单测）+ `tsc` 0 错 + `build`。
6. 结论记入 `.codebuddy/memory/YYYY-MM-DD.md`。

## 6. 验收标准

- `market_candles` 中 BTCUSDT/futures/1m 覆盖近 3 年、月数≥35、无缺口（质检连续）。
- `interval=1m` 回测**全程不联网**（DB 命中），单次 research 出权益曲线与 walk-forward 段。
- 三策略 1m research 报告与旧 4h 结论**对比**：明确粒度错配是否改变 viability 判定（预期 donchian/mean_reversion 成本结论在 1m 更差或持平，trend 需重估）。
- 160+ 测试全绿、build 通过。

## 7. 风险与回退

- **代理抖动**（实测已现）：逐月失败不中断 + 可续传；必要时 `probe` 快速失败提示。
- **DB 读取性能**：1.57M 行 `BETWEEN openTime` 走 `(symbol,market,interval,openTime)` 唯一索引前缀，快；首次全量载入内存对象数分钟内。
- **回退**：本方案纯增量（新列/新表源/新拉取器/新 CLI 分支），不改实盘；任一环节失败可停在该步，旧 vectorized-on-candle 路径照常。
