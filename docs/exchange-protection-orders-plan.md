# 交易所侧保命条件单（Protective Stop on Exchange）· 技术方案

> 来源：《策略与交易链路审计-问题清单》P2-8（出场状态仅内存，重启即丢失）与 okx-py-quant 审计中"实盘止损全绑进程"的警示。
> 定位：**不把出场迁到交易所**，而是为每个 Lot 在交易所注册一条"进程死了也还在"的**灾难止损保险丝**；策略侧出场（吊灯/信号/篮子追踪）仍是第一道闸。
> 状态：**已批准执行 Phase 1（保险丝 MVP），以默认 `PROTECTION_MODE=off` 合入。** off 时所有新路径短路 no-op → 对当前 dry_run/回测**零行为变更**；真金上线（live/testnet 带杠杆、无人值守）前，须先跑通 §9.5 testnet 演习再把开关置 `fixed`。
> 执行前提：本方案守的是“进程猝死 + 有真仓 + 无人盯”三条件同时成立的尾部风险。dry_run 且无 OPEN 仓时（当前即如此）不构成敞口，先按 off 建好、择时启用。
> 修订记录（2026-10-05 评审）：①§4.1/§10 契约类型路径更正（`OpenLotRequest`/`StrategyLotView` 在 `apps/server/src/strategy/types.ts`，非 shared）；②§3.2 补“马丁篮子级灾难”提醒；③§5.6 补“数量漂移”重挂；④§9 把 testnet 演习钉为 enable-live 硬门禁；⑤§6 Phase 2 trailing 降为可选后置。

---

## 1. 业界调研与出处

| 主流做法 | 细节 | 出处 |
|---|---|---|
| Freqtrade `stoploss_on_exchange` | 每笔持仓在交易所挂一张止损条件单；`stoploss_on_exchange_interval` 周期同步止损位（撤旧挂新）；下单失败时 `emergency_exit` 市价兜底 | freqtrade 文档 Configuration / Stoploss on exchange |
| Binance USDS-M 条件单 | 2025-12 起 `/fapi/v1/order` 拒收条件单（-4120），必须走 `POST /fapi/v1/algoOrder`（`algoType=CONDITIONAL` + `triggerPrice` + `workingType=MARK_PRICE`，可加 `priceProtect`） | 本项目 `docs/binance-api/fapi-endpoints.txt` + 适配器实测注释 |
| Hummingbot / Nautilus | 订单级 attached cancel/exit order，交易所侧存活 | 各自文档 |
| 反面教材（okx-py-quant） | 止损只在 worker 轮询里判现价，进程挂=仓位裸奔，且回测用 bar 内 low 触发、实盘只看 close——parity 断裂 | 上轮审计 |

**结论**：交易所侧只挂 **STOP**（保命线），不挂 TP——本平台的止盈全是动态语义（吊灯、篮子追踪、布林中轨），交易所固定触发价表达不了；这正是 Freqtrade 的边界（stoploss on exchange，trailing 靠周期性撤挂同步）。

## 2. 现状核实（方案设计前提，均已验证）

1. **条件单通道已存在且线上可用**：`binance-futures.adapter.ts` `placeOrder` 已按 `isConditional` 分流到 `/fapi/v1/algoOrder`，参数 `algoType/triggerPrice/workingType=MARK_PRICE/clientAlgoId` 齐备；`cancelOrder(conditional=true)` 走 `DELETE /fapi/v1/algoOrder`；`normalizeAlgoOrder` 已处理 `TRIGGERED/FINISHED` 状态。
2. **`placeStopOrder`（马丁网格入场层）证明全链路可跑**：挂单落 `NEW` → 交易所触发 → `syncPendingFills` 把 `NEW` 也纳入回查（代码注释明确"挂单被触发后本地仍是 NEW，不回查就永远发现不了已成交"）→ 补记 fill、挂接 Lot。**本方案复用这条链，只是把"开仓意图"换成"平仓意图"。**
3. **hedge 模式约束（实测过，-1106）**：平仓 = 反向 `side` + `positionSide`，**不能带 reduceOnly**；单向模式 = `reduceOnly=true`。LONG Lot 的保命单 = `STOP_MARKET SELL positionSide=LONG qty=lot.quantity`——hedge 语义保证该单只减多仓、仓位不足时触发失败，**不会反手开空**，因此"先挂新再撤旧"的换单顺序是安全的。
4. **平台当前无任何 TP/SL**：`strategy/types.ts` 明示"开仓不含止盈止损：出场完全由策略决定"；`position-lot.entity.ts` 无 TP/SL 列。第 151 行注释"TP/SL 快照落库"是现货决策循环时代的历史残留，合约侧不存在。
5. **P2-9 已修复**：四策略出场循环均已过 `hasPendingClose` 闸（donchian/trend/mean-rev 已对齐马丁）。本方案不重复处理。
6. **平仓单已写 `lotId`**（2026-09-02 P1 修复），`syncPendingFills` 可按 lotId 精确结算——保命平仓单沿用同一机制。
7. **dry_run 基础**：`processDryRunGridOrders` 按行情模拟本地条件单触发，与真实成交共用同一记账路径。
8. **`MARGIN_CALL` 归因哲学**（`position.ts` 注释）：出场归因必须区分"风控失效"与"止损位设计"——由此本方案新增独立归因 `STOP_ON_EXCHANGE`，不与策略主动 `STOP_LOSS` 混记。

## 3. 设计总览

```
开仓成交(两条路径:当场 confirmMarketFill / 事后 syncPendingFills)
   └─▶ attachProtection(lot)          ← 保险丝注册点（唯一新增副作用）
         挂 STOP_MARKET 反向平仓单（qty=Lot.quantity，触发价=灾难线）
         订单类型 PROTECTION，写 lotId；lot 记 protectionOrderId
每个 tick：策略侧出场照常判（吊灯/信号/时间/篮子）→ closeLot
   └─▶ 成交结算后 detachProtection(lot) ← 撤保险丝（先撤单再结算亦可，见 §5.4）
保险丝被交易所触发（进程死了/断网时唯一生效路径）
   └─▶ syncPendingFills 识别 PROTECTION+lotId → 结算 Lot，exitReason='STOP_ON_EXCHANGE'
ProtectionReconciler（周期任务，幂等）
   └─▶ OPEN Lot ↔ 本地 NEW 保险丝 ↔ 交易所 openAlgoOrders 三方对账：补挂/撤孤
```

### 3.1 三条核心不变量

- **I-1 不抢跑**：灾难线必须比策略侧止损**更宽**（更远）。正常活着时永远由策略先出场，保险丝只在策略失能时兜底。平台校验：`灾难线亏损距离 ≥ 策略最近止损 × protectionFloorRatio`（拿不到策略止损时用 `PROTECTION_MIN_PCT`），不满足则收窄到 floor 值。
- **I-2 先于强平**：LONG 灾难触发价必须**高于**预估强平价（SHORT 低于），留 `safetyBuffer`。预估强平价用近似式 `entry × (1 ∓ (1/leverage − maintMarginRate − takerFee))`；拿不到维持保证金率时退化校验"灾难线亏损 < 1/(2×leverage)"。10x 杠杆下即：灾难线必须落在 −5% 以内触发。
- **I-3 量具零污染**：保命层是**纯实盘运维层**，不接回测引擎、不改闸门数据、不进策略信号路径。SDK 侧全部用可选字段扩展，SimBroker/EventBroker 不实现即 no-op——回放 parity 不受影响（区别于 P0-1/2/3 那类口径问题，本方案两侧行为差异是**设计意图**且只存在于失效场景）。

### 3.2 触发价来源：策略声明 + 平台兜底

`OpenLotRequest` 增加可选字段：

```ts
/** 交易所侧灾难止损价（策略给；省略则平台按 PROTECTION_DEFAULT_PCT 兜底；null 显式关闭） */
protectionStopPrice?: number | null;
```

各策略取值建议（第一期接入 donchian/trend，其余先吃平台兜底）：

| 策略 | 灾难线初始值 | 理由 |
|---|---|---|
| donchian / trend | 开仓时吊灯位 × 1.5 宽（或 entry − 2×ATR） | 吊灯是"设计止损"，灾难线是"失效兜底"，必须分层 |
| mean-reversion | entry − 2×ATR（其 ATR 硬止损的 2 倍宽） | 同上 |
| martingale | 篮子最深一层 entry − 3×gridStep | 篮子出场靠追踪止盈，灾难线只防"整篮裸奔" |
| 未声明 | env `PROTECTION_DEFAULT_PCT`（默认 5%） | 全局兜底 |

> ⚠️ **篮子级灾难提醒（马丁）**：保险丝是**逐 Lot** 注册，马丁篮子=多层 Lot 叠加，触发其中一条只平**那一层**，不保证平整篮。马丁真实风险是“整篮 × 杠杆”的**账户级爆仓**，逐 Lot 灾难线只能聊胜于无（防单层裸奔，不防整篮雪崩）——账户级熔断/减仓是**另一条独立线**，不在本方案范围。前端展示马丁保险丝时须标“仅逐层、非篮子级”。

## 4. 数据与配置改动

### 4.1 类型与枚举（注意落点）

- `packages/shared/src/position.ts`：`LotExitReason` 增加 `'STOP_ON_EXCHANGE'`（与 `STOP_LOSS`/`MARGIN_CALL` 并列；注释说明：保险丝触发=运维失效证据，归因独立）。**（此文件确认存在，路径无误）**
- `apps/server/src/strategy/types.ts`：⚠️ 路径更正——`OpenLotRequest`（现 :108）与 `StrategyLotView`（现 :14）**实际定义在 server 侧 SDK 契约，不在 `packages/shared`**。此处 +`OpenLotRequest.protectionStopPrice?: number | null`（见 §3.2）、`StrategyLotView.protectionStopPrice: number | null`（供第二期吊灯同步与重启回读用，第一期先落字段不消费）。

### 4.2 数据库（`DB_SYNCHRONIZE` 加列，历史行取默认值）

- `position-lot.entity.ts`：
  - `protectionOrderId: string | null`（当前有效保险丝订单 id，1:1）
  - `protectedStopPrice: number`（默认 0；=0 表示未注册）
- `orders` 表（OrderEntity）：`source` 枚举新增 `'PROTECTION'`（与 grid/manual 并列）；复用现有 `stopPrice/lotId/positionSide` 列，不新增列。

### 4.3 配置（`configuration.ts` + `.env.example`）

```
PROTECTION_MODE = off | fixed | trailing   # 总开关，默认 off（灰度）
PROTECTION_DEFAULT_PCT = 5                 # 未声明灾难线时的兜底距离（%）
PROTECTION_FLOOR_RATIO = 1.2               # I-1: 灾难线 ≥ 策略止损 × 该系数
PROTECTION_RECONCILE_SEC = 300             # 对账周期
```

`fixed`=第一期（开仓挂一次不移动）；`trailing`=第二期（吊灯同步）；`off` 全部路径短路返回。

## 5. FuturesTradingService 改动细则

### 5.1 新方法 `placeProtectiveStop(lotId)`（live/testnet）

1. 读 Lot（OPEN 且 quantity>0）+ 目标灾难价（`attachProtection` 传入或按 §3.2 兜底计算，tickSize 对齐用 `normalizeOrder({type:'LIMIT'})` 口径，同 `placeStopOrder`）。
2. 过 I-1/I-2 校验；不通过 → **收窄后继续**（不是拒挂），log 记录调整。
3. 订单落库：`type='STOP_MARKET'`、`source='PROTECTION'`、`lotId`、`positionSide=lot.direction`、`side=反向`、`reduceOnly`（单向模式 true / hedge false）、`clientOrderId='pt_<lotShort>_<ts>'`。
4. 调 adapter（自动进 algoOrder 分支，补传 `priceProtect='true'` 防插针假触发）。
5. 成功后 `lots.attachProtection(lotId, order.id, stopPrice)`；失败仅 log（保险丝缺失 ≠ 开仓失败，**不阻断记账主流程**，由 Reconciler 下轮补挂）。

### 5.2 挂接点（两处，覆盖成交的两条路径）

- `settleOrOpenLot` 的 open 分支（`createFromOpenFill` 之后）；
- `syncPendingFills` 建 Lot 成功处（demo 异步成交主路径）。
两处统一调 `attachProtection(lot, req.protectionStopPrice)`；`PROTECTION_MODE=off` 或 `protectionStopPrice===null` 跳过。

### 5.3 dry_run 语义

`dry_run` 不触交易所：订单本地落 `NEW`（同 grid 单模式），由 `processDryRunGridOrders` 扫描条件——把其过滤从"网格挂单"放宽为 **`source in (GRID, PROTECTION)`**，mark 穿越灾难价即按"触发价−滑点"模拟成交并走 `settleFromCloseFill`（exitReason 同 `STOP_ON_EXCHANGE`）。模拟室因此可以完整演练保险丝行为。

### 5.4 撤保险丝 detach（三个触发面）

1. **主动平仓成交结算时**（`settleFromCloseFill` 之后，live/testnet/dry_run 一致）：`cancelOrder(protectionOrderId)`；撤单失败（已触发/已成交）不报错——留给 5.5 的对账归因。
2. **策略信号平仓与市场灾难单竞态**：保险丝先触发 → `syncPendingFills` 按 lotId 结算 `STOP_ON_EXCHANGE`；随后策略平单会因"仓位不足"被交易所拒——`closeLot` 现有 FAILED 路径自然兜住，log 级别降为 warn（识别"竞态已平"标记）。
3. **`reconcileOrphanLots` 归档 CLOSED Lot 前**：先撤其保险丝（防孤儿埋伏未来仓位——hedge 下 `SELL+positionSide=LONG` 只吃多仓，但下一轮开多的 Lot 会撞上去；这是本方案**最危险的反例**，必须有第 3 条）。

### 5.5 保险丝触发结算（syncPendingFills 内）

现有分支按 `order.reduceOnly/lotId` 结算平仓已成立；只需把 `exitReason` 从默认 `'MANUAL'` 改为按 `order.source==='PROTECTION' ? 'STOP_ON_EXCHANGE' : 原逻辑`，并顺带撤同 Lot 残留（防御自身重复）。同时回写 `lot.protectionOrderId=null`。

### 5.6 `ProtectionReconciler`（新定时任务，仿 syncPendingFills 的幂等风格）

每 `PROTECTION_RECONCILE_SEC`：
- **缺挂**：OPEN + `MODE≠off` + 无 NEW 保险丝的 Lot → 补挂（灾难价按当前吊灯近似重算或沿用上次，第一期沿用兜底重算）。
- **孤儿**：CLOSED/CANCELLED Lot 仍挂 NEW 保险丝 → 撤。
- **数量漂移**：保险丝挂单量在 attach 时冻结为 `Lot.quantity`；若 Lot 因加仓/部分平导致 `quantity` 变化，旧保险丝即**欠保/超保**——检测到 `lot.quantity ≠ 保险丝订单 quantity` 时，按“先挂新（新量）成功 → 再撤旧”重挂（与第二期 trailing 换单复用同一时序，保证双挂窗口只多不减、不反手）。
- **账外脱漏**：live 下 `GET openAlgoOrders` 返回的本平台 `pt_` 前缀单在本地无记录 → 撤（宁可裸奔也不留错单，log 告警）。
- 重启预热：`resumeIfShould` 完成后立即跑一轮——**顺带成为 P2-8 的部分解药**：从保险丝订单的 `stopPrice` 可回读"灾难线地板"，吊灯恢复时以其为下限重新播种（第二期做实）。

## 6. 吊灯/追踪同步（第二期，`PROTECTION_MODE=trailing` 才启用）

> **性价比评级：低 → 建议无限期后置。** trailing 只在“进程活着”时上移保险丝，而进程活着时策略侧出场（吊灯/信号）本就先触发——trailing 的边际安全很小，却引入撤挂风暴/限频复杂度。先把 Phase 1（fixed 保险丝 + Reconciler）落地即用，Phase 2 待有具体诉求再评估。

- `StrategyExecutor` 增加可选方法 `syncProtection(lotId, stopPrice): Promise<void>`；SimBroker/EventBroker 提供 no-op 实现（契约不破 parity）。
- 语义：**只上移、不下移、永不撤销方向**；触发价上移幅度 < `max(0.25×ATR, 0.3%)` 时忽略（防抖+限频）；换单顺序 = **先挂新高价新单成功 → 再撤旧单**（§2.3 hedge 语义保证双挂窗口只多不减、不会反手）。
- donchian/trend 吊灯上移处调用；马丁篮子不动（灾难线是静态篮子地板）；策略内存 Map 记 `lastSyncedStop`，重启后首帧先读 `lot.protectedStopPrice` 对齐基线（消灭"重启后重复撤挂风暴"）。

## 7. 明确范围外（本方案不做）

- ❌ 交易所侧止盈（TAKE_PROFIT_MARKET）：平台止盈全是动态语义，固定触发价无法表达（对齐 Freqtrade 边界）。
- ❌ OCO/组合单：USDS-M 无原生 OCO；保险丝与策略出场天然互斥靠 5.4 撤单 + 5.5 竞态兜底，不用组合单。
- ❌ 回测引擎任何改动（I-3）。
- ❌ 逐 Lot 精确 TP/SL 语义上移交易所——只是保险丝，不是执行引擎。

## 8. 风险与边界清单

| 风险 | 缓解 |
|---|---|
| demo/testnet algoOrder 端点行为与文档不符（响应缺 algoId、TRIGGERED 状态枚举差异） | 开工第一步做 testnet 冒烟（脚本挂→手动穿越→查 GET algoOrder 状态），把实测字段固化进 normalizeAlgoOrder |
| 撤单与触发竞态窗口 | §5.5：syncPendingFills 是唯一结算权威；撤单失败≠已撤销，必须以查询结果为准 |
| 频繁换单触发限频 | 第二期防抖阈值 + 换单只在 tick 决策循环（非热路径）；Reconciler 周期 ≥60s |
| 保险丝价格穿越开仓价（立即触发） | `priceProtect=true` + 挂前校验触发价方向；被 -4183 拒则 log 告警不重试 |
| 多用户/多实例并发挂撤 | 全部以 Lot 为键、Lot 属实例，天然隔离；无账户级共享状态 |
| 强平先于保险丝发生 | I-2 校验 + `MARGIN_CALL` 归因已存在，Reconciler 对已没仓的 Lot 走现有孤儿归档路径 |

## 9. 实施分期与验收

### Phase 1（保险丝 MVP）
shared 枚举/字段 → entity 列 → place/cancel/attach/detach + 5.5 归因 + 5.6 Reconciler + dry_run 覆盖 + 配置项（默认 off）。

**验收**：
1. 单测：灾难价 I-1/I-2 校验、触发归因 `STOP_ON_EXCHANGE`、detach 三面、Reconciler 幂等（重复跑无副作用）、off 模式零副作用。
2. 回归 parity：三策略既有回测快照测试零 diff（证明量具未动）。
3. 模拟室全链路：dry_run 开→保险丝落库→价格穿灾难线→本地模拟触发→Lot 结算归因→前端 Lot 详情显示。
4. testnet 冒烟：真实 algoOrder 挂/触发/撤/回查四动作。
5. **演习场景（方案成立性证明）**：live(testnet) 开仓 → `pm2 stop` → 行情穿灾难线 → 交易所侧成交 → 重启 → Reconciler+syncPendingFills 补记 Lot CLOSED、归因 `STOP_ON_EXCHANGE`、飞书告警一条。

> **硬门禁**：上述 testnet 演习（尤其 `pm2 stop` 期间交易所侧独立成交）未跑通前，**禁止把 live 实例的 `PROTECTION_MODE` 置任何非 off 值**。Phase 1 代码本身以默认 off 合入，与当前 dry_run 行为零差异，可安全进主干；但“启用保险丝”这一步只在演习通过后才对 live 生效。

### Phase 2（trailing 同步 + P2-8 回读）
`syncProtection` 契约与 donchian/trend 接线、防抖换单、重启从保险丝回读吊灯地板。
**验收**：换单只上移不反手（断言双挂窗口时序）、限频压测、重启后首帧不产生撤挂风暴。

### Phase 3（前端与告警）
持仓页保险丝状态列（挂单价/在途/裸奔红标）、`STOP_ON_EXCHANGE` 触发即推飞书（运维失效证据链）。

## 10. 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/shared/src/position.ts` | +`STOP_ON_EXCHANGE` 枚举 |
| `apps/server/src/strategy/types.ts`（契约类型实际所在，非 shared） | +`OpenLotRequest.protectionStopPrice?`、`StrategyLotView.protectionStopPrice`；P2: +`syncProtection?` |
| `apps/server/src/database/entities/position-lot.entity.ts` | +2 列 |
| `apps/server/src/exchanges/binance-futures.adapter.ts` | conditional payload +`priceProtect` |
| `apps/server/src/futures/futures-trading.service.ts` | +place/cancel ProtectiveStop、attach/detach、5.5 归因、dry_run 过滤放宽 |
| `apps/server/src/account/lot.service.ts` | +attach/detach/updateProtection、reconcileOrphanLots 撤单前置 |
| `apps/server/src/futures/protection-reconciler.service.ts`（新） | 对账任务 + 模块接线 |
| `apps/server/src/config/configuration.ts` / `.env.example` | +4 配置项 |
| `apps/server/src/backtest/sim-broker.ts` / `event-broker.ts` | P2: `syncProtection` no-op（一期零改动） |
| P2: `donchian-breakout.strategy.ts` / `trend-following.strategy.ts` / `martingale-grid.strategy.ts` / `mean-reversion.strategy.ts` | 开仓请求带灾难线；P2: 吊灯处调 syncProtection |

---

*设计原则回顾：调研驱动（Freqtrade/Binance 官方端点实测）、主流对齐（只做 exchange-side stop，不做 exchange-side TP）、量具零污染（I-3 回测/闸门不动）、拒绝半成品（detach 三面 + Reconciler + 竞态归因全部闭环后才算交付）。*
