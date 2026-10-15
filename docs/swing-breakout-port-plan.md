# 摆动突破策略（swing_breakout）：Smart Gold Hunter v2.0 能力移植与 BTC 适配方案

> 状态：**v1.0 终版 · 待批准后开工**
> 目标：按当前策略管理模块新增独立策略 `swing_breakout`（label：**摆动突破策略**，参考 Smart_Gold_Hunter_v2.0 反编译重建版），把其"ZigZag 摆动结构 + 极值位 STOP 突破单 + 负偏移入场 + 单调追踪 + 定向 one-shot"完整决策面移植到 BTC 永续，全部机制回测可复现（parity 先行）。
> 载体：新策略文件 + 新 manifest，**不改 donchian/martingale 一行代码**（对齐 `martingale-grid-v2-king-port-plan.md` 的 M8 载体范式）。
> 关于"保证盈利能力"：**任何方案都无法保证盈利**。本方案保证的是三件事：①机制逐条可证伪（独立开关 + 单变量过闸）；②不达门槛**不上架不合 live**（闸门三判据 DSR≥0.5 / OOS Sharpe>0 / OOS 回撤<10%）；③SGH 的可疑语义（前视、重绘、负偏移）全部透明化为开关做对照实验，用数据裁决而不是信宣传。

---

## 0. 源码逐行审读事实底账（2452 行全覆盖，行号为锚点）

| # | 机制 | 源码证据 | 移植判定 |
|---|---|---|---|
| S1 | ZigZag 重建：Depth=12/18、Deviation=10pt（3/5 位报价×10 归一）、Backstep=3，两遍 pass：主 pass 极值图算法 + 二遍强制交替/同侧刷新 | L28-33、L400-557 | ✅ 移植（纯函数） |
| S2 | 信号窗口：固定 300 根 CopyRates，极值扫描 shift 1..99（跳过 0 号未收盘 bar），取 **最先两个非零值**（不校验交替性） | L28-29、L560-608 | ✅ 移植，重绘语义天然一致（见 §1 C-3） |
| S3 | 方向判定：旧极值>新极值 → BUY STOP 挂旧高点侧；新>旧 → SELL STOP 挂旧低点侧；要求现价距 actionable 极值 > 10pt 触发距离闸 | L686-740 | ✅ 移植 |
| S4 | **负偏移入场**：entry = 极值 + offset×Point，内置档 offset 为负（Scalper −160pt≈极值内侧 0.06%），提前挂更易成交、入场价更好；代价是放松突破确认 | L226/241/256/276、L712-716 | ✅ 移植为三态开关（inside/at/outside），E2 核心实验 |
| S5 | 五档 profile：Scalper(M15,TP1500/SL300,RR5)、Swinger(M15,4500/2500,RR1.8)、PositiveRR(M30,2250/325,RR6.9)、PropScalper(初始 5000/700×2 倍保护+持仓 120s 后归位)、Custom | L214-306 | ✅ 移植 3 档 BTC 化；PropScalper 考核语义不移植（§7） |
| S6 | 追踪止损：浮盈 ≥ trailStart 激活 → SL=bid−trailDist，单调只进不退，TP 不动，broker minDistance 校验 | ManagePositions L2020-2080 | ✅ 移植（判定基准换 markPrice，§4-M4） |
| S7 | 挂单过期：expiry 从**挂单时刻**起算（setup time+expirySeconds），Scalper 12h、Swinger≈永久；过期撤单当根不补挂 | L1827-1855、OnTick 快照序 | ✅ 移植为 Bar 数口径 |
| S8 | 定向 one-shot：`HasDirectionalExposure` 同方向**持仓∪挂单**存在即挡；sticky latch 按 raw 方向翻转（反向信号出现即解除对侧锁，即使未成交） | L1600-1640、L2261-2276 | ✅ 移植（语义照抄，含 raw-reset 边缘语义） |
| S9 | 重复价抑制：与既有持仓/挂单价距 ≤50 pip（×pipScale）拒挂 | L1545-1575 | ✅ 移植为距离 % 参数 |
| S10 | 手数：risk% equity ÷ 按 SL 距离的每手亏损额（tickValue 换算），SL=0 退化固定手 | L1660-1700 | ✅ **复用我方 `computeRiskScaledQty`**（同为 SL 距离定标，口径更干净） |
| S11 | 保护链：点差闸（BTC 无对手续费语义→换 spread 过滤弱化）、每日收盘窗、周五收摊、新闻外部 oracle（fail-open）、日盈利目标/日亏限额/权益回撤 3% 保护（日锚 SyncDayState），触发→撤全单+平全仓 | L1102-1140、L1710-1795、RunSafetyCycle L1871 | ⚠️ 仅移植**日权益回撤/日亏限额**两闸（默认关，E5）；时段/新闻不移植（§7） |
| S12 | 成交后暂停：last SELL-deal（JIT 位运算怪癖 `(dealType & ~2)==1`）起 pauseSeconds 内不新开 | L2278-2300、OnTick | ✅ 移植为平仓后 cooldownSec（与 donchian 同款语义） |
| S13 | OnTick 顺序：pre-manage 快照 → 安全周期 → 过期撤单 → 追踪 → pause → Bars() 每根一锁 → 信号 → sticky → 曝光计数 → 提交 | L2380-2452 | ✅ 移植为 onTick 主链顺序（K 线驱动，天然一根一判） |
| S14 | 双价几何校验：BUY STOP 须 ask+minDist ≤ entry，SL 在 entry 下方且距离 ≥ minDist | ValidatePendingGeometry L1430+ | 🔁 币安 STOP_MARKET 无 broker 距离概念 → 简化为 tickSize 取整 + `minTriggerDistPct` 地板（马丁 v2 方案同款先例） |
| S15 | **无未来数据确认**：信号只用已收盘 bar（shift 从 1 起）+ 当前 tick；触发距离判定用实时价 | 全链路 | ✅ 与我们的 K 线收盘驱动语义吻合 |

反编译件的可信度声明：文件自认 clean-room 重建（头 L2-4），关键边缘处作者自己标了 UNCERTAIN（L676-684：10pt 缩放的乘序未隔离）。**移植以重建版语义为准，凡 UNCERTAIN 处取我方更保守解释并写进单测固定。**

## 1. 三条不变量

- **C-1 parity 先行**：所有机制由「K 线序列 + markPrice + Lot/挂单状态」纯函数复现。SGH 的秒级语义（12h expiry、60s pause、120s prop hold）一律换算为 **Bar 根数**，回测/实盘同一份代码。
- **C-2 可证伪**：entryMode（S4）、trailing（S6）、one-shot（S8）、日 DD 闸（S11）各自独立开关，单变量过闸。
- **C-3 重绘透明化**：ZigZag 极值随新 bar 到来会**回改历史 buffer**（第二遍强制交替 + 同侧刷新，S1）；SGH 原生的应对是"每 tick 用最新 300 根重算"——我方每根收盘 K 线重算同一窗口，**重绘行为与原版逐位一致**。这不是缺陷而是策略的固有语义：它赌的是"当前窗口最后两个极值"作为支撑/阻力位的有效性。单测须固定"极值回改前后信号差异"用例，禁止任何实现偷偷用"确认后才入队"的干净版（那是另一个策略，想测就再加开关）。

工程硬约束（项目规范）：参数四处同改（`DEFAULT_PARAMS`/`PARAM_SCHEMA`/`normalizeParams`/manifest）；shared 若加原语需 `pnpm --filter @ai-trader/shared build`；`runtimeInterval` 权威（默认 1h，能力申报 15m/1h/4h）；注册接缝 = 策略文件 + `strategies/swing-breakout/manifest.json` + registry 注册 + 闸门 backtestRef。

## 2. 与 MT5 环境的差异矩阵（换算需求驱动）

| 维度 | SGH（MT5 黄金） | 我方（BTC 永续） | 处置 |
|---|---|---|---|
| 点值体系 | Point/digits/pipScale 三套 | 无点值概念 | 全部距离 → **ATR 倍数或价格 %** |
| 触发判定 | 实时 bid/ask tick | K 线收盘 onTick + markPrice | STOP 挂单由交易所/SimBroker 按触发价撮合，语义保留 |
| 同 bar TP/SL 歧义 | 靠交易所逐 tick 排队 | 我方出场走策略 closeLot（mark 判定，优先级链显式） | 天然消解，**出场链按 donchian decideExit 的逐 Lot 短路范式重写** |
| 手续费 | 点差隐含 | 真实 taker 费率（单一真值 EXIT_FEE_RATE） | 负偏移档位成本优势会被 taker 吃掉多少 → E2 用费后口径裁决 |
| 交易时段 | 收盘/周五/日切 | 24/7 | 时段类全不移植；对应物=funding 结算窗 ±15min 暂停挂新单（开关，默认开） |
| 杠杆保证金 | MT5 账户口径 | availableMargin + computeRiskScaledQty 上限 maxLeverage | 复用 donchian 同套路，无新接缝 |

## 3. 移植设计（模块）

### M1 ZigZag 纯函数（新文件 `strategy/lib/zigzag.ts` + 单测）

逐行移植 S1/S2：`buildZigZag(rates, depth, deviationPrice, backstep)` + `findLatestTwoExtrema(buffers, scanLimit)`，series 索引语义原样（index 0=最新）。输入我方 `Candle[]`（升序）内部转 series，输出 `{ latest, previous }` 极值结构。
- 常数映射：deviation 10pt（两位金价 ≈ $0.10 ≈ 0.004%）黄金上是微噪清理；BTC 换算 `zigzagDeviationPct` 默认 **0.05%**（≈1h ATR 的 1/10 量级，W2 校准），depth=12/18 根数照搬、backstep=3 照搬、scanLimit=100/window=300 照搬。
- 单测：①手算 fixture 对齐 EA 行为；②极值回改重绘用例；③300 根窗口不足返回 `NOT_ENOUGH_RATES` 等价态。

### M2 信号层（策略 onTick 第 3 段）

```
信号 = f(latest, previous):
  previous.price > latest.price  → BUY_STOP 候选，actionable = previous.price(=极值)
  latest.price > previous.price  → SELL_STOP 候选
  | 现价与 actionable 距离 ≤ triggerMinDist（默认 0.05%）→ 不挂（防贴脸成交）
  entry = actionable − offsetAtrMult × ATR14      # BUY 侧；offsetAtrMult>0 表示内侧偏移
  entryMode:
    inside   → offsetAtrMult 默认 0.10（SGH 负偏移语义）
    at       → offsetAtrMult = 0（极值位精确挂）
    outside  → offsetAtrMult = −0.10（极值外侧，比原版更严的确认）
```
判定价统一 markPrice（`ctx.markPrice>0 ? mark : price`，对齐"止盈止损用标记价规范"）。

### M3 挂单管理（S7/S8/S9/S12 语义照抄）

- `exec.placeStopOrder({ stopPrice, quantity, reason:'swing-breakout' })`；每根 onTick：①过期撤单（`openOrders` 中 `now − 挂单时点 ≥ pendingExpiryBars×interval` 撤，挂单时点由策略侧 Map 记账，对齐 donchian entryTimes 范式）；②同方向已有 Lot **或在途挂单** → 挡（S8）；③latch 翻转语义：出现反向 raw 信号即解禁对侧；④距任一既有持仓/挂单价 < `dupPriceTolPct`（默认 0.05%）拒挂（S9）；⑤平仓后 cooldownSec（默认 300s）不新开（S12）；⑥撤换后**当根不判触发**由 SimBroker beginBar 语义天然保证（马丁 v2 §4.1 同款声明）。
- one-shot 帽：同时最多 1 个未触发挂单 + 1 个持仓（`suggestedMaxLayers: 1`）。

### M4 出场链（S6 + 我方 Lot 模型重写）

优先级短路（逐 Lot，donchian decideExit 范式）：**SL → TP → 追踪 SL → 日 DD 保险丝（默认关）**。
- SL/TP 挂单成交时在策略侧记账（Lot 无交易所 TP/SL，`protectionStopPrice` 另挂灾难保险丝 = entry − `disasterSlAtrMult`×ATR，复用平台 PROTECTION 通道）；
- 追踪：浮盈（mark 口径）≥ `trailStartAtrMult`×ATR 激活 → stop = mark − `trailDistAtrMult`×ATR，单调（Map<lotId, stop> 照抄吊灯实现）；激活后 TP 撤不撤做参数（SGH 保留，默认保留）。
- BTC 化初始档（源自 S5 三档形状，锚 ATR14）：

| 档 | 周期 | SL | TP | trailStart/Dist | RR |
|---|---|---|---|---|---|
| scalper | 15m | 1.0×ATR | 3.0×ATR | 0.5/0.3 | 3.0 |
| swinger | 1h | 2.5×ATR | 4.5×ATR | 1.5/0.8 | 1.8 |
| positiveRR | 1h | 1.2×ATR | 5.0×ATR | 1.0/0.4 | 4.2 |

初值来自黄金档的 RR 形状平移（TP/SL 比值保留），绝对倍数 W4 扫参修正；默认 profile=swinger（用户大周期理念）。

### M5 仓位与敞口（S10 复用）

`computeRiskScaledQty({ equity: availableMargin, atr, markPrice, riskPerTradePct, atrMult: slAtrMultOfActiveProfile, maxLeverage })`——注意定标距离用**策略 SL 真实距离**（与 SGH 分母一致），riskPerTradePct 默认 0.5（SGH input 1.0 的减半保守值）。

### M6 日权益保险丝（S11 子集，默认关）

`dailyLossGuardPct`（默认 0=关）：策略内记当日锚（UTC 日切，SyncDayState 语义），availableMargin+未实现 回撤 ≥3% → 撤全挂单+平全仓+当日不再启（对侧 E5 实验）。**定位声明**：这是策略参数行为不是平台风控（manifest riskNotes 原则不破）。

## 4. 参数换算总表（注册四处接缝）

| 新参数 | SGH 原型 | 换算 | 默认 |
|---|---|---|---|
| zigzagDepth | 12/18 | 根数照搬 | 12 |
| zigzagDeviationPct | 10pt×Point | 价格距离 % | 0.0005 |
| zigzagBackstep / extremaScanLimit / ratesWindow | 3/100/300 | 照搬 | 3/100/300 |
| triggerMinDistPct | 10pt | 距离地板 | 0.0005 |
| entryMode / offsetAtrMult | −160pt | 三态开关×ATR | inside / 0.10 |
| slAtrMult / tpAtrMult / trailStartAtrMult / trailDistAtrMult | profile 点数 | ATR 化（§3-M4 表） | swinger 档 |
| pendingExpiryBars | 12h | 12h=interval 根数 | 12（1h 下） |
| cooldownSec | 60s | 秒语义保留（时间闸） | 300 |
| dupPriceTolPct | 50pip | 距离 % | 0.0005 |
| riskPerTradePct / maxLeverage | 1.0% / — | 复用 shared | 0.5 / 10 |
| disasterSlAtrMult | 硬止损 −8% 语义近似 | ATR 化 | 4.0 |
| pauseAroundFunding | — | BTC 对应物 | true |
| dailyLossGuardPct | Prop 3% | 默认关 | 0 |

## 5. 闸门实验序列

语料：≥3 年 1m 归档聚合、执行周期 **1h 与 4h 双档各跑**（跨周期存活才算数；15m scalper 档仅当 E1-E4 全过后作为假设检验追加——先过大周期才配谈小周期，成本碾平教训常驻）。

| 实验 | 内容 | 通过门槛 |
|---|---|---|
| E0 | at 档基线（entryMode=at，其余全开） | 方向正确性：费后>0 且 WF OOS Sharpe>0，否则全案止损 |
| E1 | vs donchian 冠军基线同语料对照 | 笔数显著更高（摆动结构频率优势兑现），回撤不劣 3pp 以上 |
| E2 | entryMode inside vs at vs outside | 三方费后对照：负偏移的入场价优势 > 假突破增量的净证据，取赢家档 |
| E3 | trailing on/off（纯 TP/SL 对照） | 追踪档 OOS 回撤显著更低才保 inside trailing |
| E4 | one-shot 帽 1 vs 2（同向多单） | 频率收益与回撤代价显式化 |
| E5 | +日权益保险丝 | 尾部事件专项（2024-03、2025-10 插针窗）改善即留，全局劣化即删开关 |
| E6 | 全开 plateau（±20% 邻域扫参） | plateau≤20%；DSR 按累计尝试数计算 ≥0.5；不过即不合闸 |

## 6. 工作包

| W | 内容 | 预估 |
|---|---|---|
| W0 | 策略壳：`swing-breakout.strategy.ts`（先只挂 at 档最简链）+ manifest + registry + 四处同改核查 | 1d |
| W1 | zigzag.ts 纯函数 + 三类单测（含重绘 fixture） | 1.5d |
| W2 | 信号层 + 挂单管理（M2/M3 全语义） + 单测 | 2d |
| W3 | 出场链 M4 + 定标 M5（接线 closeLot） | 1.5d |
| W4 | 回测台核对：STOP 撤换/当根不触发/mark 判定口径走查 + 语料准备 | 1d |
| W5 | E0-E6 执行 + 报告 + 终态参数；浏览器全链路验收（模拟室实跑） | 2.5d |
| W6 | getState 运行状态透出：当前双极值、挂单价与过期时刻、追踪态、保险丝状态 → 详情页现有展示兼容（不新建 M8 级面板） | 1d |

合计 **10.5d**。W5 E0 不过闸 → 止步交付"摆动结构信号源研究结论"，不合闸不上架（证伪本身即产出，对齐马丁方案 §7 收尾哲学）。

## 7. 明确不移植清单

| 项 | 理由 |
|---|---|
| PropScalper 120s 最短持仓（S5 内） | prop 考核工具语义（凑持仓时长防判违规），与策略 alpha 无关 |
| 每日/周五收盘时段管控、交易日历 | 外汇时段体系，BTC 24/7 无对应物 |
| 新闻外部 oracle（SetExternalNewsBlock） | 平台已有 news/calendar 模块，若 E 后需要再作平台层注入评审（与 donchian v2 M3 同一接缝，不重复建设） |
| MT5 点差/最小距离/pipScale 全套 | §2 差异矩阵已换 %/ATR |
| deal 位运算怪癖 `(type&~2)==1` | JIT 逆向残留，语义就是"卖出成交后暂停"，取干净等价（S12） |
| Swinger 27000h 准永久挂单 | 我方 expiry 记账在策略内存，重启即失效，挂"永久"反而掩盖状态丢失；上限钳 1000 根 |

## 8. 风险声明

1. **盈利不可保证**：SGH 原版无任何公开回测/实盘统计披露，其有效性证据=「商业 EA 长期在售 + 反编译者愿意还原」，属弱证据。本方案对它的定位是**新信号源假设**（摆动极值位比通道沿口更早触发），真伪由 E0-E6 裁决；我方唯一保证是不过闸不上架。
2. **重绘赌性**：C-3 揭示的极值回改是双刃剑——策略每根 K 线看到的"最后两个极值"可能已被回改，挂撤单频率会高于直觉预期，费率占比在 E 系列单列审计。
3. **同源集中度**：与 donchian 同属突破族（正相关风险），若两者都合闸，组合层敞口共用同一账户保证金，需在策略管理上明确 riskBudget 分配（记入实验台账，对齐马丁方案 M8 注意事项）。
4. **反编译件残差**：重建版与原厂行为可能存在审计未覆盖的分支差异（作者自标 UNCERTAIN 处之外仍有不可证部分）；移植以本文件事实底账为准，差异即差异，不追认。
