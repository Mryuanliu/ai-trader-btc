# 移除 dry_run 模式 · 实施方案

> 状态：**已执行完毕（2026-10-15 深夜）**，回归 277/277 通过，服务已切 testnet 运行。
> 决策来源：用户原话「去掉 dry_run，币安测试网就是我们的测试环境」。

## 1. 目标与边界

- **移除 `dry_run` 运行模式**：`RUN_MODES` 从 `['dry_run','testnet','live']` 收窄为 `['testnet','live']`。
- **testnet（币安 demo）成为唯一 pre-live 测试环境**：所有实验单真实走 demo 交易所（真实撮合、真实延迟、真实拒单/限频），飞书全模式推送。
- 不做：不动回测台（回测从不读 mode）；不动历史数据（`orders`/`position_lots`/`baskets` 里 mode='dry_run' 的行保留作审计留痕）；不改 migrations 历史文件。

## 2. 现状触点清单（已全量核实）

| 层 | 文件 | dry_run 用法 |
|---|---|---|
| shared | `types/common.ts:64-71` | RUN_MODES / RUN_MODE_LABELS / 注释 |
| shared | `types/futures.ts:216` | DEFAULT_FUTURES_AGENT_CONFIG.mode 默认值 |
| server | `config/configuration.ts:105` | APP_RUN_MODE valid+default |
| server | `futures/futures-config.service.ts:57` | 建行兜底默认值 |
| server | `exchanges/exchange-registry.service.ts:36` | defaultEnvironmentOf 兜底 |
| server | `feishu/feishu-agent.service.ts:65` | runMode 兜底 |
| server | `futures/futures-trading.service.ts`（18 处，核心） | placeOrder 本地落库分支(L635) / syncPendingFills 过滤(L289) / placeStopOrder 本地 NEW 分支(L940) / cancelOrder 本地撤销分支(L989) / protection 注册分支(L1116) / **processDryRunGridOrders 整个方法(L1369-1450)** |
| server | `scheduler/scheduler.service.ts` | triggerDryRunOrders 方法+调用点(L113-125) |
| server | `strategy/strategy-runner.service.ts` | 跳过 ensureHedgeMode(L278-280) / 模式切换撤单注释(L532-539，逻辑保留) |
| server | `overview/overview.service.ts` | getBalancesSafe 虚拟余额分支(L192-225) |
| server | `feishu/feishu-notification.service.ts` | 4 处 dry_run 过滤(L42-53) |
| server | 注释类 | lot.service / types.ts / prompts.ts / trading-journal.service / order.entity / position-lot.entity |
| web | `AdminFutures.tsx:111,343` | 模式选择器选项 + 兜底默认值 |
| web | `MobileStrategy.tsx:149` | RUN_MODE_LABELS 兜底默认值 |
| DB | `futures_agent_configs` | 当前行 mode='dry_run' |
| 测试 | 4 个 spec | exchange-protective-stop / feishu-notification / protection / trading-journal |

## 3. 改动方案

### 3.1 shared（改后必须 `pnpm --filter @ai-trader/shared build`）
1. `RUN_MODES = ['testnet','live']`；`RUN_MODE_LABELS` 删 dry_run；更新 L64 注释。
2. `DEFAULT_FUTURES_AGENT_CONFIG.mode: 'testnet'`。

### 3.2 server 配置
3. `APP_RUN_MODE: Joi.string().valid('testnet','live').default('testnet')`。
4. futures-config / exchange-registry / feishu-agent 三处兜底 `'dry_run'` → `'testnet'`。

### 3.3 交易链路（`futures-trading.service.ts`）
5. **删除 `placeOrder` dry_run 本地落库分支**：全部走真实发单；密钥未配置时**明确抛错**（不再静默写本地单——静默落库正是「显示有持仓但交易所没有」这类困惑的源头）。
6. `syncPendingFills` 的 `mode !== 'dry_run'` 过滤改为 **`exchangeOrderId 非空`**（历史 dry_run 行无 exchangeOrderId，天然被排除，无需按 mode 过滤）。
7. **删除 `placeStopOrder` dry_run 分支**：挂单全部走 algoOrder 真实下单。
8. `cancelOrder` 的 dry_run 分支收敛为 `!order.exchangeOrderId` 本地撤销兜底（保留）。
9. **删除 protection 注册 dry_run 分支**：保险丝全部真实注册。
10. **删除 `processDryRunGridOrders` 整个方法**（本地模拟触发网格单的逻辑整体退役）。

### 3.4 调度与运行器
11. `scheduler.service.ts`：删除 `triggerDryRunOrders` 及 tick 内调用点。
12. `strategy-runner.service.ts`：删除「dry_run 跳过 ensureHedgeMode」分支——两种真实模式都必须确保双向持仓；模式切换撤单逻辑（testnet↔live）保留，仅更新注释。
13. `overview.service.ts`：`getBalancesSafe` 删除虚拟余额分支，总是读交易所；失败返回空行（前端显示 `--`）。

### 3.5 通知与观测
14. `feishu-notification.service.ts`：删除 4 处 dry_run 过滤——lotOpened/lotClosed/basketClosed **全模式推送**（dry_run 已不存在）；protectionTripped 行为不变。
15. `trading-journal.service.ts`：日志继续全模式记录，仅更新注释措辞。

### 3.6 web
16. `AdminFutures.tsx`：模式选择器删 dry_run 选项；兜底默认值改 'testnet'。
17. `MobileStrategy.tsx`：兜底默认值改 'testnet'。

### 3.7 DB 与实体
18. `order.entity.ts` 的 `mode` 列 default `'dry_run'` → `'testnet'`（新行 mode 总由代码显式写入，default 只是兜底，**免迁移**）。
19. 数据修正：`UPDATE futures_agent_configs SET mode='testnet'`（见 §5 Runbook）。
20. 历史 dry_run 的 orders/lots/baskets：**保留作审计**（mode 列即留痕）。

### 3.8 测试与回归
21. 更新 4 个 spec 中的 dry_run 用例（protective-stop / feishu-notification / protection / trading-journal）。
22. 回归顺序：`shared build` → `server typecheck` → `vitest 全量` → `server build` → `web typecheck`。

## 4. 行为变化（必须知情）

1. **实验成本变了**：不再有零成本本地模拟室。每个策略实验都真实走 demo 交易所——有成交延迟、拒单、限频。这是目的（测试环境=真实环境），但实验节奏会比 dry_run 慢。
2. **demo ≠ live 仍在**：demo 撮合与主网有差异（滑点/流动性不真实），上 live 前的小资金验证一步不变。
3. **飞书从此刻起全推**：testnet 的所有开仓/平仓/了结都会推群。
4. **密钥缺失 = 启动即明确失败**，不再静默跑本地单。
5. 回测台、Lot/Basket 模型、绩效口径完全不受影响。

## 5. 切换 Runbook（改完代码后的执行序列）

1. 前端停 V2 实例（避免切换瞬间产生孤儿单）。
2. 处理 dry_run 遗留持仓：当前 `BK-20261015-002`（LONG 0.001，本地模拟、交易所无对应）。两个选项见 §6-DP2。
3. `.env`：`APP_RUN_MODE=testnet`。
4. `pnpm --filter @ai-trader/shared build && pnpm --filter server build`，pm2 重启。
5. DB：`UPDATE futures_agent_configs SET mode='testnet' WHERE ...`（或删行让服务按新默认重建）。
6. 前端合约面板确认 mode=testnet → 重新启动 V2 → 验收：demo 交易所有单、飞书收到开仓推送。

## 6. 待用户拍板

- **DP1 历史 dry_run 数据**：保留审计（推荐，mode 列留痕）vs 清理。
- **DP2 当前 dry_run 篮子 `BK-20261015-002`**：(a) 切换时由 `reconcileOrphanLots` 自动归档为 0 盈亏（推荐，符合「交易所是唯一事实来源」）；(b) 切之前先在库里手动置 CLOSED。两者结果等价，区别只在留痕方式。
- **DP3 `orders.mode` 列 default 改实体免迁移**（代码总显式传 mode，default 仅兜底）——如无异议按此执行。
