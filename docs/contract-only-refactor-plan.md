# 精简为「仅合约交易」改造方案

> 状态：**待确认**（v1，2026-08-31）
> 目标：删除所有现货相关代码与前端 UI，本项目只做合约（U 本位永续）交易。
> 已用 code-explorer 全量调研现货/合约耦合，结论见下。

---

## 一、核心结论（务必先读）

**本项目现货与合约耦合很深，不能简单"删现货文件夹"。** 共用基础（L0~L3 决策内核、orders 表、LotService、MarketExecutor、调度器 tick、账户表）是合约赖以运转的，必须保留。真正纯现货、可安全删除的是**一部分引擎/配置/适配器/回测/UI 页面**。

按删除策略分三类：

| 分类 | 处理 |
|---|---|
| **纯现货（可整删）** | 现货引擎、现货配置表/服务、现货适配器、现货回测引擎、现货 UI 页、移动端整组 |
| **混合模块（清理现货分支，保留壳）** | 决策内核、TradingModule、AccountModule、Overview、Backtest、Scheduler、Execution、MarketModule、AgentModule |
| **合约专属（必留，不动）** | futures/ 目录、binance-futures.adapter、AdminFutures、合约回测 |

> ⚠️ **最易误伤**：删现货 `agent-engine.service.ts` 时，同目录的 `decision-core.service.ts`（L0~L3 决策内核）是合约 `FuturesEngine` 的依赖，**绝不能删**。

---

## 二、删除清单

### 2.1 纯现货（整删）

**server 端：**
- `agent/agent-engine.service.ts`（现货引擎，L4~L6 现货执行）
- `agent/agent-config.service.ts` + `agent-config.module.ts`（现货配置，`agent_configs` 表）
- `trading/risk.service.ts` + `risk.controller.ts`（现货风控）
- `account/account.service.ts`、`account/position.service.ts` 的 `getPosition`（现货持仓推导）——**保留 `getRoundTrips` 与 `LotService`**
- `account/position.controller.ts`（若有）
- `backtest/engine.ts`（现货回测）+ `backtest.service.ts` 的 `doRunSpot` 分支
- `execution/spot-executor.ts` 及 `ExecutionModule` 里的 SpotExecutor 注册行
- `exchanges/binance.adapter.ts`、`okx.adapter.ts`（现货/其他适配器；`adapter.interface`、`exchange-registry`、`exchange-account.service` 必留）
- `overview/overview.service.ts` 里的现货持仓/盈亏聚合部分（改为只展示合约）

**前端（整删页面/组件）：**
- `pages/admin/AdminAgentConfig.tsx`（现货策略配置）
- `pages/mobile/` 整组（MobileHome/MobileTrade/MobileOrders/MobileAgent）
- `components/OrderPanel.tsx`（现货买卖面板）

**shared：**
- 纯现货类型/函数（如 `computeSpotRoundTrips` 若合约不用、现货专用 DTO）

### 2.2 混合模块（清理现货分支，保留合约需要的壳）

| 模块 | 保留 | 清理 |
|---|---|---|
| `agent/decision-core.service.ts` | **整个保留**（L0~L3 决策内核，合约核心依赖） | 无（现货传 `longOnly:true`，合约不传） |
| `agent/strategy.service.ts`、`llm.client.ts`、`prompt.ts` | 整个保留（合约 hybrid 也用） | 无 |
| `agent/agent.module.ts` | 保留对 `DecisionCoreService/StrategyService/LlmClient` 的导出 | 移除 `AgentEngine` 的 provider 与导出 |
| `trading/trading.service.ts` | 保留（orders 表共用出口、`list`/`statsToday`/`recent`/`syncOpenOrders`、`getRoundTrips`） | 移除现货 `placeOrder` 的现货侧、现货风控调用 |
| `trading/orders.controller.ts` | 保留 `/orders`、`round-trips`（合约也用） | 移除现货专属字段/逻辑（若有） |
| `account/lot.service.ts` | **整个保留**（现货/合约共用，`market` 参数） | 无 |
| `account/position.service.ts` | 保留 `getRoundTrips(market)` | 删除 `getPosition`（现货推导） |
| `account/account.module.ts` | 保留 `LotService`、`LotsController` | 移除 `AccountService`/`PositionService.getPosition` |
| `execution/` | 保留 `MarketExecutor` 接口、`MarketExecutorRegistry`、`ExecutionModule` 壳、`FuturesExecutor` 注册 | 删 `SpotExecutor` |
| `overview/overview.service.ts` | 保留（改为只聚合合约持仓/盈亏） | 删现货持仓、现货余额、现货盈亏部分 |
| `backtest/` | 保留 `futures-engine.ts`、`doRunFutures`、`funding_rates`、`market_candles(futures)` | 删 `engine.ts`（现货回测）、`doRunSpot` |
| `scheduler/scheduler.service.ts` | 保留 `runFuturesIfDue`、`syncOpenOrders`、`probeExchanges`（合约） | 删 `runAgentIfDue`（现货）、`snapshotBalances`（现货）、`recoverMarket`、现货模拟行情 |
| `market/market.module.ts` + `candle-store` | 保留模块壳与合约 K 线读写 | 删现货行情订阅、`pumpSimulation` |
| `app.module.ts` | 保留共用 Module + FuturesModule | 移除已删的现货模块注册 |

### 2.3 合约专属（必留，不动）
`futures/` 全部、`exchanges/binance-futures.adapter.ts`、`database/entities/futures-agent-config`/`funding-rate`、`backtest/futures-engine.ts`、`apps/web/src/pages/admin/AdminFutures.tsx`。

---

## 三、数据库表

| 表 | 处理 |
|---|---|
| `agent_configs` | ✅ 可删（纯现货配置，随 AgentConfigService 一起） |
| `balance_snapshots` | ⚠️ 现货专属，若 `SchedulerService.snapshotBalances` 删掉后可随迁移清理 |
| `futures_agent_configs` / `orders` / `trade_fills` / `position_lots` / `agent_decisions` / `market_candles` / `funding_rates` / `exchange_accounts` / `risk_events` / `news_items` / `users` | ❌ **必留**（现货/合约共用或合约专属） |

> 建议：**保留表结构与历史数据**（orders/decisions 里现货行的 `market='spot'` 可留作审计），只删 `agent_configs` 纯现货配置表。数据库删除是**可选**的，可等代码跑稳后再做迁移。

---

## 四、前端路由与页面调整

- `router.tsx`：删移动端路由整组、删 `/admin/agent`（现货配置）；保留 `/admin` 下的 Overview/Orders/Backtest/Accounts/Risk/Futures，但各页**只展示合约**（market 锁定 `futures`）。
- `AdminOverview`：改为合约总览（合约持仓、合约盈亏、合约 Lot、合约订单）。
- `AdminOrders`：market 默认/强制 `futures`，去掉现货切换。
- `AdminBacktest`：只留合约回测（杠杆参数）。
- 删 `AdminAgentConfig`、`OrderPanel`、移动端页面。

---

## 五、实施顺序与风险控制

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 备份：先 `git commit` 当前状态（含之前所有 Lot/合约改动） | 低 |
| 2 | 删 shared 纯现货代码 → 构建 shared → 全量 typecheck 定位引用 | 中 |
| 3 | 删 server 纯现货文件 + 清理混合模块 → typecheck/build 逐轮修 | **高**（易误删共用内核） |
| 4 | 删前端现货页面/路由 → web typecheck/build | 中 |
| 5 | 跑测试（重点：合约回测、LotService、decision-core） | 中 |
| 6 | 合约链路端到端验证（/futures 决策、合约回测、dry-run） | 中 |
| 7 | 可选：数据库迁移删 `agent_configs`/`balance_snapshots` | 低 |

**每步跑 `pnpm --filter @ai-trader/shared build` + `pnpm typecheck`**，一旦报错立刻修复，绝不带病进入下一步。

---

## 六、待确认问题

1. **数据库存量数据**：现货历史订单/决策（`market='spot'` 的行）和 `agent_configs`/`balance_snapshots` 表，是**保留**（代码删、数据留）还是**连表一起删**？（建议：代码先删，表结构保留，跑稳后再删）
2. **移动端**：确认整组删除移动端（`/m` 路由 + Mobile* 页面）？还是只删现货、保留一个合约移动端入口？
3. **AdminOverview/AdminOrders/AdminBacktest/AdminRisk**：这些是混合页，确认改成"market 锁定合约"（保留页，只显示合约）而不是整页删除？
4. **现货适配器 binance.adapter/okx.adapter**：确认删除（合约只用 binance-futures）？ExchangeAccount 里若登记了现货账户记录是否保留？
