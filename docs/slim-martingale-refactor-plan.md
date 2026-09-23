# 策略托管平台改造方案（v-final）

> 状态：**主体实施完成，待重启服务验证**（2026-09-23）
> 定位（用户原话）：**「我们就是一个各种策略的集中管理平台，我们只提供绑定交易所和下单交易，还有监控订单情况的能力」**

## 实施进度（2026-09-23）

**已完成**（shared / server / web 全部 typecheck + build 通过）：

| 项 | 结果 |
|---|---|
| 删除决策引擎 | `decision-core` / `futures-engine` / `futures-decisions` / `strategy.service` / `agent-decisions` 实体全部移除 |
| 删除风控 | `futures-risk` / `risk.service` / `risk.controller` 移除；`FuturesTradingService` 的 5 处风控依赖拆净，改为「交易所参数前置校验」 |
| 删除回测 | `apps/server/src/backtest/`（7 文件）+ `AdminBacktest` 页移除（顺带消除 2 个历史失败测试） |
| 删除执行器抽象 | `apps/server/src/execution/`（MarketExecutor 注册表，唯一消费者是决策引擎）移除 |
| 新增策略层 | `apps/server/src/strategy/`：`types.ts`（契约）/ `martingale-grid.strategy.ts` / `strategy-registry` / `strategy-executor` / `strategy-runner` / `strategy.controller` / `strategy.module` |
| STOP 挂单链路 | shared `OrderType` 加 `STOP_MARKET`/`TAKE_PROFIT_MARKET`；`PlaceOrderInput.stopPrice`；`orders.stopPrice` 列（迁移 11000）；适配器支持；`placeStopOrder`/`cancelOrder`/`listOpenOrders`/`processDryRunGridOrders` |
| 对账增强 | `syncPendingFills` 纳入 `NEW` 状态（挂单成交后可被发现）+ 成交后推进订单状态 |
| 配置瘦身 | `futures_agent_configs` 删 11 个决策/风控列（迁移 12000）；`FuturesAgentConfigShape` 精简为 7 字段 |
| AI 行情 | `ai-market.service` + `ai-market.controller`（`GET /api/ai/market`）；只解读行情，输出不进入下单路径 |
| 前端 | 删 Orders/Decisions/Risk/Backtest/MobileOrders 页 + 3 个决策组件；新增 `AdminStrategy`（策略卡片页，含未平仓拦截弹窗）与 `AdminAiMarket`；路由与菜单重排；`AdminFutures` 去掉熔断/策略参数/手动决策 |

**已执行**：迁移 `1700000011000-OrderStopPrice`、`1700000012000-FuturesConfigSlim`（`migrationsRun: false`，需手动 `pnpm migration:run`）。

## 第二轮：深度瘦身 + 数据库清理（2026-09-23 第二轮）

**shared 瘦身**（删除 25 个文件）：

| 删除内容 | 说明 |
|---|---|
| `src/strategy/` 整目录 | 3 个旧策略 + 注册表 + 上下文映射 + 4 个测试 |
| `decision-diagnostics.ts` | 决策诊断归因（阻塞原因码/信号贡献） |
| `types/market-executor.ts` | 跨市场执行器契约（唯一消费者是被删的执行器） |
| `types/exit-rules.ts` + 测试 | 决策链路的出场规则 |
| `src/analysis/` | 信息系数分析（回测用） |
| `indicators/signals.ts` + 测试 | 信号合成（决策内核用；`indicators/core.ts` 保留，策略在用） |
| `types/agent.ts` | 仅剩 OrderDTO，迁到新文件 `types/order.ts` |
| `apps/server/scripts/` | 4 个参数扫描脚本（依赖旧策略 + 回测） |
| `apps/server/src/agent/prompt.ts` | 决策提示词（无消费者） |
| `agent-decision.entity.ts` | 决策记录实体 |

**前端瘦身**：`hooks.ts` 从 700+ 行降到 498 行（删决策/诊断/回测/风控 hooks）；`realtime.ts` 去掉 decision/risk 事件；删 `ActionTag`（决策动作标签）；`MobileAgent`（决策流水）→ 改造为 `MobileStrategy`（策略状态 + 启停），移动端 Tab 精简为 资产/交易/策略。

**后端死代码清理**：`loadPositionRisk`、`FUTURES_RISK_REASONS`、`resolveFuturesOrderIntent`、`isHoldIntent` 移除。

**数据库清理**（迁移 `1700000013000-DropDeadTables` + 数据清空）：

- **DROP 5 张死表**：`risk_events`（5.8 万行）、`agent_decisions`（4.9 万行）、`agent_configs`、`balance_snapshots`（7909 行，仅 module 注册无读写）、`funding_rates`（42 行，仅回测用）
- **TRUNCATE 3 张表**：`orders`（3767）、`trade_fills`（178）、`position_lots`（64，含 **15 条会阻止策略启动的 OPEN 记录**）
- **保留**：`market_candles`（12.6 万根 K 线）、`news_items`（814）、`exchange_accounts`、`futures_agent_configs`、`users`、`migrations`

**新增测试**：`apps/server/src/strategy/__tests__/martingale-grid.spec.ts`（13 例）覆盖参数归一化、首层双向 STOP 挂单、加层抑制、篮子追踪止盈/止损、出场前撤单、单侧金字塔过滤。shared 28 例 / server 13 例，全部通过。

**本轮验证**：shared build+test ✅ / server typecheck+build+test ✅ / web typecheck+build ✅ / lint 0 错误。

## 待办

1. **重启后端服务**（当前跑的是旧 `dist`）：
   `kill <pid> && cd <repo> && nohup node apps/server/dist/main.js > /tmp/ai-trader-server.log 2>&1 &`
2. **demo 端到端验证**：挂载马丁网格 → 观察 STOP 挂单挂出 → 价格触发成交 → 建 Lot → 篮子追踪止盈平仓。
3. 可选：`orders.decisionId` 列已无写入（恒为 null），可连同 `OrderDTO.decisionId` 一并清理。

## 最终决策（2026-09-23，全部确认）

| 问题 | 决定 |
|---|---|
| 项目定位 | 策略托管平台：只做「绑定交易所 + 下单交易 + 监控订单」，**不做任何风控** |
| 首层开仓 | **忠于 EA**：启动即双向挂 STOP 挂单，距现价 `first_step`，谁被突破谁成交（非市价开仓） |
| 每侧层数 | **6 层**，倍率 1.5 |
| 持仓结构 | **忠于 EA：单侧金字塔 + 快速掉头**（`hold positions on at most ONE side`，趋势过滤主动砍另一侧；单侧深亏 + 30s 动量反向 → 双侧 carry 过渡） |
| 网格触发 | **真实挂单**：币安合约 `STOP_MARKET`（需实现挂单管理 / 平移跟踪 / 撤单 / 成交回调 / 部分成交处理） |
| 出场 | **忠于 EA：只用篮子追踪止盈**（整篮子净盈亏 − 成本达阈即平，**无逐层止盈**，需实时跟踪盈亏峰值） |
| AI 行情分析 | 独立「AI 行情」页面 |
| 策略管理页 | 策略合集卡片，点击启动即跑；若存在未完结仓位单，提醒用户手动处理 |
| 回测 | 暂时删除 |

---

## 一、项目定位重定义

| 能力 | 归属 |
|---|---|
| 绑定交易所（API Key / 测试网 / 账户） | ✅ 平台提供 |
| 下单交易（开仓 / 平仓 / 撤单 / 挂单） | ✅ 平台提供 |
| 监控订单（持仓、成交、挂单、盈亏） | ✅ 平台提供 |
| **风控**（杠杆钳制、熔断、敞口限制、强平预警、保证金校验） | ❌ **平台不做**，全部由策略自己负责 |
| 策略逻辑（何时开、何时平、倍率、间距） | ❌ 平台不干预，策略自治 |

**含义**：删除全部风控代码。策略是黑盒，平台只负责「把指令正确地送到交易所」+「把交易所的真实状态展示出来」。

---

## 二、删除清单

### 2.1 风控（全删）

| 文件 | 处置 |
|---|---|
| `apps/server/src/futures/futures-risk.service.ts` | 删 |
| `apps/server/src/trading/risk.service.ts` | 删 |
| `apps/server/src/trading/risk.controller.ts` | 删 |
| `apps/server/src/database/entities/risk-event.entity.ts` | 从 `all.ts` 注销（**实体文件保留**，见下方迁移说明） |
| `apps/web/src/pages/admin/AdminRisk.tsx` | 删 |
| 前端 hooks：`useRiskEvents` | 删 |
| `futures-config` 中风控字段（杠杆上限/强平距离/敞口上限/日亏损熔断） | 删 |
| `scheduler` 中的熔断检查 | 删 |

> **迁移处理**：`1700000001000-RiskHardening.ts` **保留不动**（TypeORM `migrations` 表已有执行记录，删文件会破坏迁移链）。`risk_events` 表留在库中不读写，无害；如需清理，单独写一个 `DROP TABLE` 迁移。

### 2.2 决策引擎（全删，已确认）

| 文件 | 处置 |
|---|---|
| `apps/server/src/agent/decision-core.service.ts` | 删 |
| `apps/server/src/agent/strategy.service.ts` | 删 |
| `apps/server/src/futures/futures-engine.service.ts` | 删 |
| `apps/server/src/futures/futures-decisions.service.ts` | 删 |
| `apps/server/src/database/entities/agent-decision.entity.ts` | 从 `all.ts` 注销 |
| `packages/shared/src/strategy/`（registry / trend-following / mean-reversion / breakout / context-mapping） | 删，仅留 `types.ts` 中转需要的类型 |
| `apps/web/src/pages/admin/AdminDecisions.tsx` | 删 |
| `agent_decisions` 相关 hooks / 路由 / 菜单 | 删 |
| `packages/shared/src/decision-diagnostics.ts` | 删 |

### 2.3 回测（全删，已确认）

| 文件 | 处置 |
|---|---|
| `apps/server/src/backtest/`（整个目录） | 删 |
| `apps/web/src/pages/admin/AdminBacktest.tsx` | 删 |
| CLI 回测命令、回测路由/菜单、`useRunBacktest` 等 hooks | 删 |
| `futures-engine.spec.ts` 等 2 个既有失败测试 | 随回测一起删（顺带解决历史遗留） |

### 2.4 订单页面（用户此前明确要求删）

| 文件 | 处置 |
|---|---|
| `apps/web/src/pages/admin/AdminOrders.tsx` | 删（独立列表页） |
| `apps/web/src/pages/mobile/MobileOrders.tsx` | 删 |
| `apps/server/src/trading/orders.controller.ts` 的 list 路由 | 删（**下单/撤单路由保留**） |
| 组件 `OrderCalendar.tsx` / `DecisionTimeline.tsx` / `DecisionDiagnosticsPanel.tsx` | 删 |
| hooks `useOrders` / `useRecentOrders` / `useDecisions` / `useLaneStats` / `useDecisionDetail` / `useDecisionDiagnostics` / `useRoundTrips` / `useAllLots` | 删 |

> ⚠️ **订单监控能力不消失**：改为内聚到「策略详情」与「合约面板」中（持仓 / 未完结 Lot / 挂单 / 最近成交 / 盈亏），符合「平台提供监控订单能力」的定位。

---

## 三、必须保留

- **交易出口**：`futures-trading.service.ts`（合约下单唯一出口）、`binance-futures.adapter.ts`、`binance.adapter.ts`
- **仓位单**：`position_lots` 表 + `LotService`（网格层 = 仓位单）
- **记账**：`orders` / `trade_fills` 表
- **行情**：`market.service.ts` + K 线存储
- **账户**：`account.service.ts` / `position.service.ts` / `futures-position.service.ts` / `exchange-account.entity`
- **平台**：`auth`、`gateway`（实时推送）、`overview`（总览看板，已去 mock）
- **AI**：`agent/llm.client.ts` + `prompt.ts`（改造为「AI 行情分析」服务）

---

## 四、黄金 EA 机制移植（已通读 `king-v4-balance.mq5`，4783 行）

### 4.1 核心参数（EA 原始值）

| EA 参数 | 值 | 说明 |
|---|---|---|
| `GOLDKING_FIRST_STEP_POINTS` | 30 | 首单挂单距离（点） |
| `lot` | 0.01 | 起始手数 |
| `GridLotMultiplier` | **1.5** | 震荡区马丁倍率（用户选 6 层对应此值） |
| `TrendMultMin` | 1.1 | 强趋势区倍率（压平防爆） |
| `StepAtrMult` | 1.00 | 网格间距 = 系数 × M1_ATR |
| `FastTakeProfit` | 0.80 | 每仓快速止盈（$ per 0.01 手） |
| `MaxPerSide` | 10 | 每侧最大持仓数（用户改为 **6**） |
| `NetExposureCap` | 0.08 | 最大净敞口 \|多−空\|（手） |
| `PivotLossPct` / `PivotMomThreshold` | — | 快速掉头：深亏 + 30s 动量反向 |

### 4.2 入场：双向 STOP 挂单网格（"始终运行"）

源码 `TryPlacePendingOrders` 核心：

```cpp
// 无持仓 → 立即挂首单（无条件）
if(stats.buy_positions == 0)
    target_price = ask + (first_step + spread);     // BUY_STOP 挂上方
if(stats.sell_positions == 0)
    target_price = bid - first_step;                 // SELL_STOP 挂下方

// 加层：价格相对最低持仓不利移动 ≥ step
buy_condition = (buy_positions == 0)
             || (target <= buy_lowest_position - buy_step)
             || (target >= buy_highest_any + buy_step && buy_rebalance);

// 手数：首层 × 倍率^层数
volume = EffectiveBaseLot() * MathPow(DynamicLotMultiplier(true), stats.buy_positions);
```

**结论（回答「首层怎么开」）**：
> **启动后立即双向挂出第一层挂单**——上方 `BUY_STOP`、下方 `SELL_STOP`，各距现价 `first_step`。
> **谁的价先被突破，谁先成交开仓**，另一侧挂单继续等待。不是启动即市价双向开仓。

### 4.3 动态倍率（regime-adaptive martingale）

```
|market_score| ≤ 震荡阈值       → 1.5     （马丁主场：深档放大，回撤时整体了结）
|market_score| ≥ 强趋势阈值     → 1.1     （接近平推：逆势侧只线性失血，不指数爆炸）
中间                            → 线性过渡
```

### 4.4 动态网格间距（方向化）

```
震荡区 → 最小间距（DYNAMIC_STEP_MIN_POINTS）
趋势区 → 70~150 点，且分方向：
          趋势同向侧 120 → 90（更密，顺势多铺）
          趋势逆势侧 140 → 150（更疏，逆势少铺）
```

### 4.5 趋势过滤：单侧金字塔 + 快速掉头

`ApplyTrendGridFilter` 明确语义（**⚠️ 与用户此前「双向锁仓」的说法冲突**）：

```
hold positions on at most ONE side
有买无卖 → 只 allow_buy（并主动删除 SELL 挂单）
有卖无买 → 只 allow_sell
两边都有 → 保留层数多的一侧
都没有   → g_market_score >= 0 决定方向

快速掉头(FAST PIVOT)：单侧深亏 + 30s 动量强烈反向
  → 不切单侧（保留旧仓不认亏），改为双侧 carry，
    让新方向的盈利单去配对平掉旧仓
```

### 4.6 出场：篮子级追踪止盈（**⚠️ 非每单固定止盈**）

`TryAutoCloseLogic` 顺序：
```
1. 首单跟踪止盈  TryFirstOrderTrailingClose
2. 篮子跟踪止盈  TryBasketTrailingClose
3. 保护性单侧平仓 TryProtectiveCloseBySide
     ↑ 基于「净盈亏 − 成本（手续费 + 滑点）」触发，不是每层固定百分比
```

### 4.7 移植到 BTC 合约的适配点

| EA（黄金 XAUUSD） | 移植方案 |
|---|---|
| `_Point` / `PriceDistancePoints` / `PipDivisor`（品种点值） | 改为 **BTC 价格百分比**或 **ATR 倍数**（EA 本就有 `StepAtrMult × M1_ATR`，直接用它做主基准） |
| `lot`（手数） | 改为 **USDT 名义金额 / 币数量**，首层 = 可用保证金 × 杠杆 × `basePct` |
| `NetExposureCap`（手） | 改为 **净敞口名义 / 权益 百分比** |
| `FastTakeProfit`（$/0.01手） | 改为 **每仓收益率 %** |
| MT5 pending order（BuyStop/SellStop） | 币安合约 **STOP_MARKET 挂单** 或 **tick 轮询模拟**（见待确认 Q2） |
| MT5 净持仓账户 | hedge mode（双向持仓，各自独立仓位单） |

---

## 五、策略运行器（替代决策引擎）

```ts
// apps/server/src/strategy/types.ts
export interface StrategyContext {
  symbol: string;
  price: number;
  atr: number;                 // ATR14（网格间距基准）
  openLots: PositionLotView[]; // 未完结仓位单
  availableMargin: number;
  netQty: number;
  params: Record<string, unknown>;
}

export interface StrategyExecutor {
  openLot(input: { direction: 'LONG'|'SHORT'; quantity: number; takeProfitPct?: number; stopLossPct?: number; reason: string }): Promise<{ lotId: string|null; error?: string }>;
  closeLot(lotId: string, reason: string): Promise<{ ok: boolean; error?: string }>;
}

export interface TradingStrategy {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly defaultParams: Record<string, unknown>;
  readonly paramSchema: Record<string, unknown>;
  normalizeParams(raw?: Record<string, unknown>|null): Record<string, unknown>;
  onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void>;
  getState(): Record<string, unknown>;
}
```

运行器职责：`start` / `stop` / `tick`（每 3~5 秒）/ `getState`；**启动前检查未完结仓位单并提醒用户手动处理**。

---

## 六、页面

| 页面 | 内容 |
|---|---|
| `AdminStrategy.tsx` | 策略合集卡片，点击启动即跑；运行中显示层数/敞口/浮盈；启动前若存在未完结仓位单则弹窗列出并要求先手动平仓 |
| `AdminAiMarket.tsx` | AI 行情分析独立页（市场状态、置信度、新闻情绪、AI 点评） |
| `AdminFutures.tsx` | 精简：启用开关、保证金/杠杆、持仓与仓位单、手动 tick |
| `AdminOverview.tsx` | 保留（已改造完成） |
| 移动端 | 保留首页/交易/Agent，删除订单页 |

---

## 七、待确认的 3 个核心矛盾

### Q1（最重要）：单侧金字塔 vs 双向锁仓

EA 的真实行为是**只在一侧持仓**（`ApplyTrendGridFilter` 会主动删掉另一侧挂单），并带「快速掉头」；而你此前明确说过「双向开单，同时有买入与卖出」并接受锁仓。

- **A. 忠于 EA**：单侧金字塔 + 快速掉头（趋势过滤会砍掉另一侧）
- **B. 双向锁仓**：多空各自独立网格、各自止盈，不互相砍（你此前的说法）
- **C. 双向锁仓但沿用 EA 的「快速掉头」**：默认双向，仅当单侧深亏 + 动量反向时才切换

### Q2：挂单模式 vs tick 轮询模拟

EA 用 pending 挂单（`BuyStop`/`SellStop`）实现网格。

- **A. 真挂单**：币安合约 `STOP_MARKET` 挂单，忠实还原；需实现挂单管理、平移跟踪、撤单、成交回调、部分成交处理（复杂度高）
- **B. tick 轮询模拟**（推荐）：每 tick 检查价格是否穿越网格线，穿越则以市价开仓；效果等价，只差微小滑点，无挂单状态需维护

### Q3：出场用 EA 的篮子追踪止盈，还是每单固定止盈？

- **A. 忠于 EA**：篮子级追踪止盈（净盈亏 − 成本触发，需要实时跟踪峰值）
- **B. 每单固定止盈**（你此前的说法）：每层独立 TP/SL，触发即全量平该层，语义最直观
- **C. 先 B 兜底 + 后续加 A**：每层带 TP/SL 保底，同时用篮子追踪做整体优化

---

## 八、实施阶段（确认后执行）

| 阶段 | 内容 |
|---|---|
| S1 | shared 瘦身：删旧策略体系与决策类型，保留 Lot/合约/行情类型 |
| S2 | server 删风控 + 决策引擎 + 回测；新增 `StrategyRunner` + 策略接口 |
| S3 | 实现马丁网格策略（按确认后的 Q1/Q2/Q3 语义） |
| S4 | 前端删页面（Orders/Decisions/Risk/Backtest），新增策略管理页 + AI 行情页 |
| S5 | AI 行情分析服务 + 接口 |
| S6 | 构建校验 + dry-run 端到端验证 + 记忆 |
