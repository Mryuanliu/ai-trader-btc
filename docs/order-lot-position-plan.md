# 订单级仓位管理（Position Lot）改造方案

> 状态：**v-final —— 8 项决策全部确认，动工**（2026-08-31）
> 背景：① 持仓数字与订单管理页对不上；② 平仓语义混乱 → 改为「每笔开仓订单独立止盈止损，全量平掉该订单才算完结」。

## 用户已拍板（全部 8 项，2026-08-31）

| 问题 | 决定 |
|---|---|
| 平仓语义 | **现货：策略只输出入场时刻，出场全靠每单止盈止损；合约：BUY=开多、SELL=开空，每单独立止盈止损** |
| 现货 SELL 信号 | **忽略**（现货不做空），B4 回归出场停用，blocking reason `SPOT_SELL_IGNORED` |
| 加仓 | 允许，每方向未完结 Lot 上限 3，超出忽略信号 + blocking reason |
| 止盈止损参数 | hybrid AI 逐单给参数；strategy 链路/AI 降级用全局兜底 **SL 2% / TP 4%** |
| 合约多空共存 | **接受锁仓**（hedge mode，多空各自 TP/SL 独立运行） |
| 手动平仓 | **UI 选择目标 Lot**（卖出前列出未完结 Lot 供选择） |
| 存量持仓 | **不迁移**，用户手动在币安测试网平掉 |
| hedge 切换前提 | 两市场净持仓清零后切 `dualSidePosition=true`（手动清仓正好满足） |

---

## 一、调研结论（对账数据，2026-08-31 实测）

| 市场 | 本地成交推导 | 实读 | 差额 | 根因 |
|---|---|---|---|---|
| 合约 | 0.1144 − 0.096 = **0.0184** | 0.0184 | 0 | ✅ 吻合 |
| 现货 | 0.01565 − 0.00223 = **0.01342** | 0.013435 | +0.000015 | 币安现货买入手续费从 BTC 里扣（到账 = 下单量×(1−0.1%)），成交模型记了全量 |

「订单页对不上」直接原因（前端 bug）：`GET /api/orders` 与 `useOrders` 均无 market 过滤，**现货 tab 混列合约大单**（0.0089/0.0095 BTC 那两笔），按现货口径加总必然对不上。

现状模型问题（②的根源）：现货 SELL 走 `positionPct×equity` 预算 → 9 笔 0.0002~0.0004 碎卖蚕食持仓；止盈止损挂净持仓均价；无「订单=仓位」实体。

---

## 二、目标模型 v2（按用户决定修订）

### 2.1 决策语义（核心变化，与现状相反）

**现货：**
- 策略只负责找**入场时刻**：BUY → 开一个新 Lot（LONG）。
- **SELL 信号不再卖出持仓**：现货不做空，SELL 信号忽略并记 blocking reason（`SPOT_SELL_IGNORED`）。原「回归出场」（B4 的 %b 中轨 SELL）由逐单止盈止损替代。
- 手动 SELL = 平仓操作（平指定 Lot 或 FIFO 最旧 Lot，见 §4-Q1）。

**合约（切换双向持仓 hedge mode）：**
- BUY → 开多 Lot（`positionSide=LONG`）；SELL → 开空 Lot（`positionSide=SHORT`）。**反向信号=开反向新 Lot，不平旧仓**。
- 多空 Lot 可共存（锁仓状态），各自独立止盈止损出场：触发 → `reduceOnly=true + 对应 positionSide` 全量平掉该 Lot。
- 技术约束（实测要点，见 memory）：当前账户为**单向持仓**，必须先清掉所有持仓才能切 `dualSidePosition=true`（用户手动平存量正好满足）；切换后所有单**必须带 positionSide**，否则 -4061。代码基础已具备（`getPositionMode()`/`payload.positionSide` 分支），需改默认模式与下单必带。
- `FuturesPositionService` 需适配：positionRisk 在 hedge 下返回 LONG/SHORT 两条，`getNetQuantity` 改为 `longQty − shortQty`，toView 输出双侧。

### 2.2 出场机制：逐 Lot 止盈止损

- 每次决策循环先扫全部未完结 Lot：`现价 vs entryPrice×(1±tp/sl)`，多头触 TP/SL、空头反向同理 → 立即全量平该 Lot（优先级高于开新仓）。
- 参数来源：
  - **hybrid 链路**：AI 按市场状态逐单输出 `stopLossPct/takeProfitPct`（schema 扩展 + 钳制到 [0.005, 0.10]，非法回落默认）。
  - **strategy 链路 / AI 不可用降级**：回落全局 `exitRules` 兜底（否则 AI 挂了 Lot 永远无出场 → 必须有默认值）。
- exitReason 落 `STOP_LOSS / TAKE_PROFIT / SIGNAL（暂无）/ MANUAL / REVERSE(合约对冲解除，暂无)`。

### 2.3 数据模型：`position_lots` 表

```
position_lots
├── id / market / symbol / direction('LONG'|'SHORT')
├── openOrderId (唯一) / closeOrderId?
├── quantity / closedQuantity
├── entryPrice / entryFeeUsdt / exitPrice? / exitFeeUsdt?
├── status 'OPEN'|'CLOSED'|'CANCELLED'
├── stopLossPct / takeProfitPct   -- 本单生效的出场参数（落库快照，AI 逐单可异）
├── exitReason? / realizedPnl? / returnPct?
├── openedAt / closedAt
└── 索引 (market,symbol,status)
```

- 1 开仓单 ↔ 1 Lot ↔ 1 平仓单；回合配对从 FIFO 启发式退化为直接关联，`computeSpotRoundTrips`/`computeFuturesRoundTrips` 退役为对账校验工具。
- 存量**不迁移**（用户手动清仓）；新成交从零建 Lot。上线前提：两市场净持仓为 0（position.service 成交推导与 Lot Σ 应一致，可作断言）。
- 手动 BUY 也建 Lot（统一管理）；手动 SELL 走平 Lot 流程。

### 2.4 风控与限额

- **MAX_OPEN_LOTS**：每方向未完结 Lot ≤ 3，超出忽略同向信号 + blocking reason。
- `maxExposurePct`：合约改按方向分别钳制（Σ多头 Lot 名义 / Σ空头 Lot 名义）；现货 ΣLot 名义。
- `minOrderIntervalSec`、`MAX_DAILY_ORDERS` 不变（注意：碎单消失后每日单量自然下降）。
- 现货到账修正（随 P0）：`commissionAsset` 为基础币时 `fills.quantity` 记净到账（executedQty − commission），消除 §1.1 虚增。

### 2.5 前端

- **订单成交页**：market 过滤修复（P0）；P4 起按 Lot 分组——开仓单为主行（含该单 TP/SL 参数、状态「持仓中/已完结」），平仓单为子行；完结行显示本单盈亏。
- **持仓页/合约面板**：未完结 Lot 列表（各自入场价、浮动、TP/SL 距离）+ 汇总行；合约面板显示多空双侧。
- **总览**：今日盈亏口径不变（已实现 = 今日 CLOSED Lot 盈亏和，后端实现换数据源）。

### 2.6 回测（P6）

现货（只 BUY 入场 + 逐单 TP/SL 出场）与合约（多空 Lot、hedge、逐单 TP/SL）同步新语义，否则回测与实盘口径漂移。注意：出场全靠 TP/SL 会显著改变交易频率与持仓时长，需重跑 `param-scan.ts` 验证费率敏感性（C2 教训）。

---

## 三、分期实施

| 阶段 | 内容 | 前置 |
|---|---|---|
| **P0（立即可做，独立合入）** | ① orders list/控制器/useOrders 加 market 过滤；② 现货成交净到账修正 | 无 |
| **P1** | `position_lots` 表 + LotService（建/查/平）+ 成交回调挂接；**要求净持仓已清零** | 用户手动平掉存量 |
| **P2** | 合约 hedge mode 切换 + 决策语义（BUY=开多 Lot/SELL=开空 Lot）+ 逐 Lot TP/SL 扫描引擎 | P1 |
| **P3** | 现货引擎改造（只入场、SELL 忽略、逐 Lot TP/SL） | P1 |
| **P4** | hybrid AI 逐单 TP/SL 参数（prompt/schema/钳制/降级兜底） | P2,P3 |
| **P5** | 前端 Lot 视图（订单分组/持仓列表/合约双侧） | P2,P3 |
| **P6** | 回测引擎同步 + param-scan 重验 | P2,P3 |

改造期间先 `PATCH /api/futures/config {"enabled":false}` 停合约引擎，避免半新半旧状态下单。

---

## 四、边界点确认结果（2026-08-31 已全部确认）

- **Q1 手动 SELL**：UI 选择目标 Lot（交易面板列出未完结 Lot）。
- **Q2 多空共存**：接受锁仓，多空各自 TP/SL 独立运行（hedge mode 自然语义）。
- **Q3 兜底 TP/SL**：SL 2% / TP 4%（全局 exitRules 默认，可调）。
- **Q4 现货 SELL 语义**：确认忽略，出场全靠逐单 TP/SL（B4 回归出场停用）。

## 五、注意点（动工时遵守）

- 上线 Lot 引擎前用户须手动清空两市场存量持仓；清仓前禁止切换 hedge mode。
- 现货存量 0.01342 本地推导含 0.000015 虚增（手续费扣 BTC），用户按交易所实际数量平仓即可，差额随净到账修正后不再产生。
- 改造期间 `PATCH /api/futures/config {"enabled":false}` 停合约引擎。
- minNotional：现货 5 USDT / 合约各标的以 exchangeInfo 为准（BTCUSDT=50）。
- hedge mode 下所有合约单必带 positionSide（LONG/SHORT），reduceOnly 平仓单带对应 positionSide。
