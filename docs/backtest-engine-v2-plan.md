# 回测引擎 v2 重构方案（设计参考文档）

> 状态：**设计方案，未开工**（用户明确"不急开做"）。本文档为决策完整的技术蓝图，供后续排期实施。
> 定位：专业 BTCUSDT 永续量化平台，规划服务数百至数千用户，生产级。
> 强制标准（已固化到项目记忆）：先做主流调研并附出处 → 据主流设计 → 严谨完整有效 → 拒绝臆想与半成品 → 设计阶段准确性与主流性优先，不计工程难度。

---

## 1. Scope 与非目标

### 目标
- 覆盖 Binance USDT-margined Perp BTCUSDT（架构允许后续扩币对）。
- 撮合保真度 / 成本 / funding / 强平 / 统计验证 / 治理闸门 升级到与主流同代水准。
- **保留现有策略契约**（`StrategyExecutor` + `StrategyContext`）不变：已上架策略无需重写即可在新引擎上跑。

### 非目标
- 现货、交割合约、期权、跨币种保证金。
- 撮合级 HFT（<100ms 微观结构做市）。
- 多交易所联合撮合（P4+ 再评估）。

---

## 2. 现状基线（源码事实，来自 `apps/server/src/backtest/` 逐行审计）

### 2.1 已具备（保留并接进闸门）
- `backtest-runner.ts`：半 event-driven，市价单 **next-open** 成交杜绝前视、STOP 用 high/low 触发 + 跳空处理。
- `research/walk-forward.ts`：真 train/test 切窗、每窗 fresh 实例、OOS 拼接、`aggregateOosSharpe` + `oosMaxDrawdownPct`。
- `research/cpcv.ts`：**已实现**组合留折 + OOS 夏普分布 + 分位数。
- `research/deflated-sharpe.ts`：全式 DSR（Bailey–López de Prado 2014 近似式，含 skew/kurt/T）。
- `research/lookahead-check.ts`：确定性 + 无未来依赖双检（前视自检）。
- `historical-feed.ts`：Binance fapi klines 分页 + 本地缓存。
- `sim-broker.ts`：taker fee + slippage + funding 按 bar 时长分摊（见 L158-L183、L360-L372）。

### 2.2 差距（本方案要解决）
- **撮合保真度**：STOP 每根 bar 每个 stop **只触发一次**、taker 按单一价成交、无 L2 深度 / 队列 / 部分成交 / latency / 强平。
- **数据栈**：只有 klines；funding 用常量参数非历史序列；`ctx.markPrice = bar.close` 不是真 mark price；无 aggTrade / L2 / OI / 清算。
- **成本**：maker/taker 不分档、无半点差、无市场冲击。
- **统计验证**：CPCV 算了但闸门 `hasPassingResearch` 不读；无 PBO、regime、Monte Carlo、plateau；不校验回测周期 = 实盘周期。
- **组合层**：无多策略相关性 / 组合回撤 / 容量估计。

---

## 3. 市面主流对标（一手出处）

| 维度 | 主流做法 | 参考 |
|---|---|---|
| 范式 | event-driven 定稿、vectorized 粗筛 | IBKR Quant News (2025)、r/algotrading 共识 |
| 引擎 | Nautilus Trader、hftbacktest、QuantConnect Lean、DolphinDB Backtest | 各自官方文档 |
| 数据 | OHLCV + aggTrade + L2 depth + funding + markPrice + OI + liquidations + metadata，point-in-time 对齐 | CoinAPI 永续数据分层、DolphinDB 教程、data.binance.vision |
| 撮合 | Market-By-Price 队列概率模型（RiskAverse / ProbQueue power-log）、PartialFill、taker 吃 L2 深度 VWAP、latency 注入 | hftbacktest order_fill、MDQR (arxiv 2501.08822) |
| 成本 | maker/taker 分档 + 半点差 + 平方根律冲击 + 精确 8h funding 结算 | Almgren–Chriss (1999/2000)、Gatheral (2010)、Binance 官方 funding 规则 |
| 统计 | Walk-Forward + Purged K-Fold + CPCV + DSR + PBO + regime + MC bootstrap + plateau | López de Prado (2018) Ch.7/11/12、Bailey–López de Prado (2014) DSR & PBO、Abounader–Jaqimov (2024) CPCV 实证 |
| 强平 | mark price 判 equity < maintenance margin（position size 分层）→ 清算 | Binance USDT-M tier 表、CoinAPI 清算建模 |

---

## 4. 新回测架构 v2（分层设计）

### L0 双引擎（范式）
- 保留 `runBacktestOnCandles` 作为 **vectorized 粗筛**（sweep 网格快速回放）。
- 新增 `runBacktestEventDriven(strategy, config, marketEvents)` 作为 **event-driven 定稿**（研究 / 闸门）。
- **决策原则**：闸门 / 上架证据只允许来自 event-driven 定稿；vectorized 结果仅用于研究探索与预筛。
- 两引擎都通过现有 `StrategyExecutor` 契约给策略 → 策略代码不改即可跨引擎。

### L1 数据栈（Point-in-Time）
**新增实体**（`apps/server/src/database/entities/`）：
- `AggTrade`（symbol, ts, price, qty, isBuyerMaker, firstId, lastId）
- `L2Snapshot`（symbol, ts, bids[(p,q)×N], asks[(p,q)×N], lastUpdateId）
- `FundingRate`（symbol, fundingTime, rate, markPrice）
- `MarkPrice`（symbol, ts, markPrice, indexPrice）
- `OpenInterest`（symbol, ts, openInterest, openInterestValue）
- `Liquidation`（symbol, ts, side, price, qty）
- `SymbolMeta`（tickSize, stepSize, minNotional, mmmTiers[]）

**拉数据管道**（`apps/server/scripts/backtest-pull/`）：
- 增量：Binance fapi REST 分页（1500 上限）+ WebSocket replay 补缺。
- 历史 bulk：`data.binance.vision` 月度 zip 全量导入。
- 存储：按 (symbol, date) 分区 JSONL；研究热数据（近 1 年）DB 化，冷归档文件。

**数据质检**（每次回测启动前跑）：
- 时戳单调、缺失率、异常跳价、funding 覆盖（每次 8h 都有记录）、markPrice 覆盖。
- 引用 CoinAPI 原文："回测看着无懈可击、真数据 funding 缺失就崩"。

### L2 撮合引擎（Event-Driven + Intrabar 保真）
主循环（Nautilus 风格）：
```
events = merge_by_ts(aggTrades, L2Snapshots, markPriceTicks, fundingSettlements)
for ev in events:
    market.apply(ev)                    # 更新 orderbook + mark/index/latest
    matchingEngine.process(market)      # maker 队列概率 + taker 吃深度 + 部分成交
    riskService.check(market, account)  # markPrice 判 equity < mmm → 分层清算
    strategy.on_event(market, ctx)      # 策略决策（保留 onTick 契约做桥接）
```
- **订单状态机**：`NEW → PARTIALLY_FILLED → FILLED | CANCELED | REJECTED`；`STOP_MARKET/STOP_LIMIT → TRIGGERED → 转 market/limit`。
- **队列模型**：默认 `ProbQueueModel(power_prob_queue_model2)`（hftbacktest 主流保守档），可切 `RiskAverseQueueModel` 做压力测试。
- **Intrabar 保真**：直接用 aggTrade 逐笔（BTCUSDT ~100ms 粒度）驱动，**从根本上消除 SimBroker 每 bar 每 STOP 只触发一次的失真**——无需 bar 内路径近似。
- **Taker**：吃 L2 深度算 VWAP，剩余量按 IOC/GTC/GTD 语义处理。
- **Latency**：submit→match 与 match→notify 各注入可配延迟（默认 20ms 单边，Binance 实测中位）。
- **强平**：`equity(markPrice) < maintenanceMargin(position, tier)` 触发分层清算；以 markPrice × (1 ± liquidation_penalty) 下 market 单吃深度。
- **Parity**：新引擎保留 StrategyExecutor 全部接口方法，`onTick` 通过时间聚合器桥接。

### L3 成本模型
- **Fee**：maker/taker 分档（读 user tier from Binance `exchangeInfo`），默认 taker 4bp / maker 2bp。
- **Slippage**：不再用固定 bps，而是**由撮合自然产生**——taker 吃 L2 深度产生价格位移、maker 挂单按限价成交。
- **Bid-Ask Spread**：由 L2 快照 best bid/ask 隐含，无需单独参数。
- **Market Impact**（附加于 aggressive 单）：平方根律
  `Impact_bp = σ_daily_pct × √(Q_notional / ADV_24h_notional) × c`
  σ_daily 从日 K 计算，ADV 从 24h 成交额，c 默认 0.5（Gatheral 2010 常见取值）。
- **Funding**：每 8h UTC 精确按 `fundingRate × markPrice × netPosition` 计入 realizedPnl；历史 fundingRate 来自 L1 表。

### L4 统计验证（新闸门判据）
**沿用 + 强化**：
- **CPCV**：`research/cpcv.ts` 已实现 → 接进闸门；输出 OOS 夏普分布 + p5/p25/p50/p75/p95。
- **PBO**（新增 `research/pbo.ts`）：Bailey–López de Prado 2014 CSCV，logit(z) 秩空间拟合，报告 PBO ∈ [0,1]。
- **DSR** 全式保留（`research/deflated-sharpe.ts`）。
- **Walk-Forward** 保留。

**新增**：
- **Regime 分层**：按 BTCUSDT 日线 close vs SMA200 + 30d realized vol 分位 → 5 类 regime（bull / bear / sideways / low-vol / high-vol）；每 regime 分别 OOS Sharpe。
- **Monte Carlo block bootstrap**（保留短期自相关）：对 OOS 收益重排 N=1000 次 → 得 maxDD 分布 p5/p50/p95；闸门用 p95 maxDD。
- **Parameter Plateau**：sweep 网格冠军邻域（±1 step）sharpe 相对下降 > 20% 视为孤峰，拒绝。

**新闸门 `hasPassingResearch v2`（全部满足才放行）**：
1. 最近 30 天内有 **event-driven v2** run。
2. 回测 interval 覆盖 `strategy.manifest.capabilities.timeframes` 声明的**最细周期**（网格 = 1m）。
3. event-driven OOS Sharpe（WF aggregate + **CPCV p5**）> 0。
4. **PBO < 20%**。
5. **DSR ≥ 0.5**（per-bar）。
6. **MC p95 maxDD < 10%**。
7. **Regime 分层：五个 regime OOS Sharpe 全部 > -0.3**（防"只在某段赚"）。
8. **参数高原：冠军邻域 sharpe 下降 < 20%**。
9. 撮合开启：历史 funding / L2 深度 / queue model / latency / impact / 强平 全部启用（不允许回落到 vectorized）。

**BacktestRunEntity 字段扩展**：`pbo`、`cpcvQuantiles[]`、`regimeSummary`、`plateauScore`、`mcMaxDD_p5/p50/p95`、`engineVersion`、`fillConventionV2`。

### L5 组合层（度量为主，方案 A 不合并下单）
- **相关性矩阵**：已上架策略的日 equityCurve 两两 Pearson；> 0.7 记高度相关，> 0.85 触发人工复核。
- **组合最大回撤**：按资金权重合成 equity 曲线，MC p95 DD 报告。
- **容量估计**：用 L3 impact 反推"策略 OOS Sharpe 衰减到阈值时的规模上限"。
- **执行模式**：各策略独立下单、组合层只做度量 + 可选统一风险预算（对齐前一轮"是否合并下单"的结论）。

---

## 5. 治理与接口
- `manifest.yml` 增补 `backtestRequirements: { engine: 'event-driven-v2', timeframes: [...], minBarsPerRun, costModel: 'v2' }`。
- `setEnabled` 强制校验：最近 event-driven run 覆盖 required timeframes；否则拒绝并列出未达项。
- **沿用陷阱**（memory）：改默认参后必须先 `POST /strategy/reload`，再 `setEnabled`（否则内存清单整文件覆盖磁盘新默认参）。
- CLI 扫参仍走 vectorized（成本考虑），但**闸门结果一律 event-driven**。

---

## 6. 分阶段实施路线图

| 阶段 | 内容 | 相对工期 | 消除失真 |
|---|---|---|---|
| **P0** | 把已有 CPCV 接进闸门 + 新增 PBO + regime 分层 + MC bootstrap + plateau；闸门判据换 v2 | 小（1-2 周）| 统计严格性 |
| **P1** | L1 数据栈建表 + 拉数据管道 + L2 event-driven 撮合（队列 / taker 吃深度 / 部分成交 / latency / 强平）+ 历史 funding + markPrice | 大（4-6 周）| **"1h 不准"根因** |
| **P2** | L3 完整成本：maker/taker 分档 + 平方根律 impact + 半点差由 L2 隐含 + 精确 8h funding 结算 | 中（2-3 周）| 成本失真 |
| **P3** | L5 组合层：相关性 + 组合回撤 + 容量估计 dashboard | 小（1-2 周）| 组合盲点 |
| **P4** | 老 3 策略（martingale / donchian / mean_reversion）在新引擎重跑 + 更新 backtestRef；trend_following 若复活必须走 v2 | 小 | 治理一致 |

**建议起手顺序**：P0 优先（低成本高价值、代码已在只是没接），再做 P1（用户最担心的粒度 / 保真度问题在 P1 根治）。

---

## 7. 风险与开放问题
- **数据成本**：BTCUSDT 一年 aggTrade 数十 GB；深度 5 档快照另算 → 冷热分层 + 采样（研究热数据近 1 年 DB，冷归档文件）。
- **引擎性能**：event-driven 比 vectorized 慢 10–100× → 扫参仍走 vectorized，闸门走 event-driven 定稿。
- **队列模型标定**：`power_prob_queue_model2` 是通用保守档，实际 fill 率需与 live 数据对账；本项目暂无 live 挂单数据 → P1 上线后开始积累。
- **Binance 历史 L2 / markPrice**：REST 只给当前 depth；历史 L2 走 `data.binance.vision` 月度 zip 或第三方（CoinAPI / Velafi）；markPrice 历史走 markPriceKlines 或长期 WS 录制。
- **合约元数据版本化**：maintenance margin tier 会随币安政策变 → 表版本化 + 定期同步。

---

## 8. 参考资料（一手出处）
- Interactive Brokers Quant News, "A Practical Breakdown of Vector-Based vs. Event-Based Backtesting" (2025).
- nkaz001, **hftbacktest** docs: Order Fill Models & Queue Models — https://hftbacktest.readthedocs.io/en/latest/order_fill.html
- NautilusTrader docs — https://nautilustrader.io/
- QuantConnect Lean docs — https://www.quantconnect.com/docs/lean/
- DolphinDB, "Best Practices for High-Frequency Backtesting of Market-Making Strategies in Cryptocurrency" — https://docs.dolphindb.com/en/Tutorials/market_making_strategies.html
- CoinAPI Blog, "Historical Data for Perpetual Futures" — https://www.coinapi.io/blog/historical-data-for-perpetual-futures
- Marcos López de Prado, *Advances in Financial Machine Learning*, Wiley (2018). Ch. 7 (CPCV) / Ch. 11 (WFA) / Ch. 12 (MC).
- D. H. Bailey & M. López de Prado, "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality", JPM (2014).
- D. H. Bailey, J. M. Borwein, M. López de Prado, "The Probability of Backtest Overfitting", SSRN (2014) — https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf
- H. Arian et al., "Backtest Overfitting in the Machine Learning Era" (2024) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4686376
- R. Almgren & N. Chriss, "Optimal Execution of Portfolio Transactions" (1999/2000).
- J. Gatheral, "No-Dynamic-Arbitrage and Market Impact", Quantitative Finance (2010).
- Binance USDT-M Futures 官方文档（fapi endpoints、funding rules、margin tiers）— https://binance-docs.github.io/apidocs/futures/
- data.binance.vision 官方历史数据仓库。
