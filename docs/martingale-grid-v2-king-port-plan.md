# 马丁网格 v2：对标 king-v4-balance 完整水平的移植改造方案

> 状态：**已实施 · E0 通过（diff=0）**（v2.2：载体定为**新增独立策略**，前端仅设计新策略的「策略运行状态」区）
> 目标：新增一个与黄金 EA `king-v4-balance.mq5` 同等决策水平与防护水平的马丁网格策略 `martingale_grid_v2`；现 `martingale_grid`（只移植了骨架）**原样保留**作基线与回滚锚。
> 方式：借鉴 + 融合，不是照搬——机制照搬、参数体系换算（点值 → %/ATR）、所有机制回测可复现（parity 先行）。

---

## 0. 事实修正（v2 重写的起因）

初版方案假设"Brain 是 yuanliu 版新增、父本 balance 只有骨架"。**逐行核实 `king-v4-balance.mq5`（4784 行）后证伪**：

| 机制 | balance 是否有 | 证据（行号锚点） |
|---|---|---|
| 六因子多周期评分 ComputeFrameScore | ✅ 完整存在 | L1455 `dir=0.34·f1+0.20·f2+0.18·f3+0.12·f4+0.10·f5+0.06·f6`，权重与 yuanliu 一致 |
| 三框架融合 + 一致性阻尼 + 自适应平滑 | ✅ | L1694–1760：M1/M5/M15 权重 {0.30,0.36,0.34}；冲突≥0.40 → score×0.72；平滑系数 翻转0.80/扩张0.55/收缩0.22 |
| 粘滞趋势方向域机 g_ts_dir | ✅ | L1761–1786：TrendDirEnter/Exit/ChopGate，chop=0.55·(1−ER)+0.45·ChopIdx |
| 方向不对称间距 DirectionalGridStepPoints | ✅ | L1519–1541（基准 50→150 分段，顺势 120→90 加密、逆势 140→150 拉宽） |
| 趋势压平马丁倍率 DynamicLotMultiplier | ✅ | L1638–1656：震荡=GridLotMultiplier，强趋势=TrendMultMin 线性渐变 |
| 挂单跟踪 TryTrailPendingOrders | ✅ | L4125–4181：STOP 挂单每 5s 向现价方向平移（步进 10 点） |
| 首单 15s 快速追踪出场 | ✅ | L3122–3180 + `FIRST_ORDER_TRAIL_TIMEOUT=15s` |
| 篮子追踪（钱触发 + 价回撤双口径） | ✅ | L3056–3115：净收益 ≥ target+triggerMoney 才 arm，之后按**价格回撤** 25 点离场；arm 期间撤挂单 |
| 分侧均值 $ 目标保护平仓 TryProtectiveCloseBySide | ✅ | L3282–3378：按震荡/中性/趋势三域分别走 侧平/配对减/篮子 路径 |
| 趋势保护配对减仓 TryTrendProtectedPairReduction | ✅ | L2415–2506：盈利单+亏损单成对平，趋势域内限制平亏损侧的时机 |
| 动态篮子目标 DynamicCloseAllTarget | ✅ | L1659–1672：0.5$ × 放大器 × (1+0.8·趋势强度) × 权益缩放 |
| 复利缩放 EquityScale | ✅ | L1609–1631（默认 EquityScaleCap=1.0 即**作者实盘也关着**） |
| 反向动能掉头警报（pivot alarm） | ✅ | L3442–3456：深浮亏 + 30s 动量强烈反向 → 放行双侧 carry |
| 再平衡加层（rebalance condition） | ✅ | L4053–4054、L4073：失衡比 >3 时允许在极值外侧加层 |
| 保证金预检 CanAffordOrder | ✅ | L1922：下单前算 margin 可负担当不起就不挂 |
| 每根入场 K 线首单锁 | ✅ | L3187：`IsFirstEntryBarLocked`（M1 内不重复开首层） |
| 三层极端熔断 / HedgedUnwind | ❌（yuanliu 新增） | balance 无 ATRSpike/BigCandle/Unwind |

第二轮逐行复核锁定的六处精确事实（已折进对应模块设计）：① `CollectStats` 的 `*_any` 极值口径**包含在挂单价格**（持仓∪挂单取极值，L2139–2178）；② 域机是**七态**（震荡/弱多/多头确认/强多 × 弱空/空头确认/强空，L1461–1488）；③ 配对减仓防护判据 = 单对手数 ≤ 趋势侧敞口 30% 且配对后趋势侧剩余 ≥ 逆势侧 ×0.35–0.55（`MarketTrendProtectionRatio`，L2415–2441），选对排序键 = 亏损侧不利距离最深优先（L2488–2491）；④ `CanAffordOrder` 精确口径 `free_margin > margin×1.15 && equity > margin×1.25`（L1936）；⑤ 六因子各框架周期不同（斜率 20/18/14、ER 30/24/20、Donchian 24/20、f3 prev_shift 3/2，L1396–1444）；⑥ `AdjustVolumeAvoidLock` 在 V3.1 已退化为直通（L1840），不移植。

**结论**：我们的 `martingale-grid.strategy.ts`（673 行）当年只移植了 balance 的"双向 STOP 网格 + 单侧金字塔 + 篮子 % 追踪止盈"约 30% 决策面；本次 = 把剩余 70% 的**内核（Brain）、手数/间距/目标的评分驱动化、出场优先级链、挂单维护纪律**逐一移植进来，并融合 yuanliu 独有的三层熔断作为增强项。**载体是新增独立策略 `martingale_grid_v2`（M8），不改老策略一行代码**。

`TryFastScalpClose`（逐仓快速止盈）在 balance 中**只有声明和定义、无任何调用点**（L413/L3384）——作者自己都把它摘掉了，不移植。

---

## 1. 三条不变量（所有工作包受此约束）

- **C-1 parity 先行**：每个机制必须能由「K 线序列 + 标记价 + Lot/挂单状态」纯函数复现。凡依赖 tick 时序、点差、经纪商点值的细节，一律改写成 K 线可判定的等价形式或参数化开关；写不出等价形式的机制不进 v2。
- **C-2 可证伪**：每个机制独立开关、单变量过闸门实验（§6），任一阶段 OOS 恶化即回滚该机制、不污染其余结论。
- **C-3 马丁本质不掩盖**：改造目标是"更聪明的马丁"，不是"消灭马丁"。深套回放（最长套牢深度、深套持续时长、极端单边窗口表现）常驻每次回测报告，Brain 带来的改善必须在这张表上也成立。

工程硬约束（项目规范）：新策略参数必须四处同改——`PARAM_SCHEMA`、`normalizeParams`、`DEFAULT_PARAMS`、`strategies/martingale-grid-v2/manifest.json`；shared 包新原语需 `pnpm --filter @ai-trader/shared build` 才对 server 生效；回测与实盘使用同一策略代码路径（runtimeInterval 配置化现状保持）。

---

## 2. 现策略与 balance 的差距矩阵（改造需求清单）

| # | 能力 | balance | 我们现状（行号锚点） | 差距结论 |
|---|---|---|---|---|
| G1 | 趋势内核 | 六因子×三框架融合 + 域机 | `trendScore` 仅 EMA 斜率×0.6+偏离×0.4（L509–522） | 重构为完整 Brain |
| G2 | 间距 | 评分驱动、方向不对称（120→90/140→150） | 单一 ATR×系数钳 [min,max]（L654–662），多空同距 | 移植分段函数 %/ATR 版 |
| G3 | 马丁倍率 | 趋势域自动压平至 TrendMultMin | 固定 lotMultiplier（L45） | 移植 DynamicLotMultiplier |
| G4 | 篮子目标 | 随趋势强度动态放大 | 固定 basketStartPct（L71） | 移植动态目标 |
| G5 | 分侧出场 | 侧均值 $ 目标 + 三域分流 | 只有全篮子一个出口（L398–465） | 新增侧目标平仓层 |
| G6 | 配对减仓 | 趋势保护成对平 | 无（Lot 模型支持逐 Lot 全平，可行） | 新增 |
| G7 | 首单追踪 | 15s 窗口快速追踪止盈 | 无 | 改写为"N 根 K 线内"等价形式移植 |
| G8 | 挂单跟踪 | pending 每 5s 追价 | 挂单钉死在原价直到撤换（L609） | 新增（按 tick 重估，见 §4 说明） |
| G9 | 加层语义 | 跌 2 格后在现价上方挂反弹确认单（L4066–4074） | goneFar 只算 1 格（L628，注释还写着"2 个网格"）；无 rebalance 加层 | 恢复原语义 + 再平衡条件 |
| G10 | 极值回撤确认 | buy_lowest/`highest_any` 双极值参与条件 | 只用 worst（最不利持仓） | 补 highest_any/lowest_any |
| G11 | 风控前置 | CanAffordOrder 保证金预检、侧数上限撤挡单、首K线锁 | 无（敞口护栏=P3-13 未决） | 新增（顺带闭合 P0-2/P3-13） |
| G12 | 出场撤单纪律 | arm 追踪后立即撤挂单、trail 期间持续撤 | 只在最终平仓时撤单 | 补齐 |
| G13 | 极端行情防御 | ❌（yuanliu：三层熔断） | ❌ | 移植 yuanliu 增强项（M6） |
| G14 | 篮子追踪口径 | 钱达标才 arm + 按**价格回撤**离场 | 纯比例回撤（L423–426） | 双口径化，见 M4 |

---

## 3. 移植设计（按模块）

### M1 MarketRegime 内核模块（策略目录新增，不进 shared 运行时）

位置：`apps/server/src/strategy/lib/market-regime.ts`（纯函数 + 内部状态，策略持有实例；回测/实盘同路径）。shared 只补无状态指标原语。

**六因子单框架评分**（逐行核对 L1278–1458 后的精确公式，权重保留原值作初值、§6 再扫；各框架周期不同，保留"高框架递减回看"结构，映射规则：EA 的 M1/M5/M15 参数列依次对应我们的 1×/5×/15× 框架）：

```
per-tf 周期参数：slope_period=20/18/14  er_period=30/24/20  don_period=24/20/20  f3_prev_shift=3/2/2
atr = ManualATR14(本框架K线)              # TR 均值（Wilder 前等价简单均值，EA 自算口径照搬）
f1 = clamp(slope/0.06) × (0.5 + 0.5·R²)   # 回归斜率(ATR/Bar 归一)，拟合质量阻尼        w=0.34
f2 = sign(close_t0 − close_tN) × ER(N)     # 带符号 Kaufman 效率比                       w=0.20
f3 = 0.55·stack + 0.45·emaSlope           # EMA8/21/55：完美排列±1 否则 clamp((f−s)/ATR)；
                                          # emaSlope=clamp(Σ(0.50/0.35/0.15)·Δema_i/ATR) w=0.18
f4 = clamp((macdMain−macdSignal)/ATR/0.30) # MACD 柱动量                                w=0.12
f5 = clamp01(上破/ATR − 下破/ATR)          # Donchian 突破强度（通道**不含当根**）        w=0.10
f6 = clamp((+DI − −DI)/40)                 # ADX 方向平衡                               w=0.06
dir = clamp(Σ wi·fi)   trendiness = 0.40·ER + 0.30·R² + 0.30·min(|slope|/0.06, 1)
frameScore = 100 × dir × trendiness ∈ [−100,100]
七态域：|score|≤20 震荡；<45 弱多/弱空；<70 多头/空头确认；≥70 强多/强空（EA MarketStateText 直译，前端直接使用）
```

0.06（斜率归一常数）、0.30（MACD 归一）、40（DI 除数）都是**黄金 M1 波动标定值**，BTC 不同执行周期下量纲必变——W2 单测里对每个执行周期用 BTC 历史数据回放校准这三个常数（取 BTC 上等价分位的值），这是"借鉴不照搬"的具体落点。

**三框架融合**（balance L1694–1760 逐条移植）：
- 框架 = 执行周期 `runtimeInterval` 的 {1×, 5×, 15×}（由 1× K 线序列聚合重采样，纯函数、parity 安全）。EA 的 M1/M5/M15 在 BTC 1h 执行下即 1h/5h/15h——比黄金慢一档是市场属性，不是移植失真；参数 `regimeTfMults:[1,5,15]` 可调。
- 融合权重 {0.30, 0.36, 0.34}；一致性度 coherence、冲突权重 conflict；conflict≥0.40 → target×0.72。
- 自适应平滑：score 与 target 反号(翻转) α=0.80、同号放大 α=0.55、收缩 α=0.22，逐 tick 向 target 收敛——**这就是 EA "5 秒刷新" 在我们 K 线驱动引擎里的等价形态**（每个 tick 都更新，平滑本身即防抖）。
- 三态域阈值：RANGE_LIMIT=20 / TREND_CONFIRM=45 / STRONG_TREND=70 原样保留（0–100 无量纲，不依赖品种）。

**粘滞方向域机**（balance L1761–1786）：
```
chop = clamp01(0.55·(1−ER_1x) + 0.45·ChopIdx(20)/100)
chop > ChopGate(0.58)         → dir=0（震荡强制双向放开）
dir==0 且 |score|≥Enter(26)   → dir=sign(score)
sign 翻转且 |score|≥Enter     → dir 翻转
|score| ≤ Exit(14)            → dir=0
```

产出接口（供 M2–M5 消费）：`{ score, dir(±1/0), strength01, chop, state }`。

### M2 评分驱动三件套：间距 / 倍率 / 篮子目标

全部以 balance 分段函数为蓝本，**点值 → ATR·百分比**换算：

```
base = abs(score)
gridStep(dirSide):                       # 移植 G2（L1507–1541 骨架）
  区间[0,20]:   s0 = stepAtrMult×ATR（钳 [minStepPct, maxStepPct]）
  区间(20,45]:  s0 × (1 + 0.25·t)   # 过渡带拉宽（EA 100→140 语义）
  趋势确认后:   顺势侧 s0 × max(0.7, 1 − 0.25·t')   # 120→90 加密
               逆势侧 s0 × (1 + 0.083·t')           # 140→150 拉宽
  t, t' 为各分段归一 0–1
martinMult(dirSide):                     # 移植 G3（L1638–1656）
  |score|≤20 → gridMult(=lotMultiplier)
  |score|≥70 → trendMultMin（新参数，默认 1.0）
  中间线性渐变；顺势/逆势共用（EA 即如此）
basketStart():                           # 移植 G4（L1659–1686）
  startPct = basketStartPct × (1 + kAmp·strength01)        # 趋势越强目标越高
  sideTargetPct(顺势) = sideBase × (1 + 0.6·strength01)
  sideTargetPct(逆势) = sideBase × max(0.3, 1 − 0.28·strength01)  # 逆势快跑
```

初值先抄 EA 形状（kAmp=0.8、trendMultMin=1.0），§6 扫描修正。**注意**：我们 `lotMultiplier` 冠军教训（1.0 稳健/1.5 衰减）与"趋势压平"不矛盾——压平是让震荡域敢用 >1 的倍率、趋势域退回等权，恰好可能解开"倍率不敢开"的困局，由 E2 实验验证。

### M3 挂单与网格维护纪律（补齐 balance 下单语义）

改造 `ensureSide`/`ensureGrid`：

1. **回归确认加层恢复原语义**（G9）：加层条件 = 现价相对最不利持仓反向走远 **2 个网格** 且相对**极值**也走远 1 格——注意 EA 的 `*_any` 极值口径 = **持仓价 ∪ 挂单价** 取极（CollectStats L2139–2178），我们须从 `openLots + openOrders` 合并计算；才在现价外侧 1 格挂 STOP（反弹确认单）。当前 1 格版是移植走样，注释与代码自相矛盾（策略 L624–628）。
2. **再平衡加层**（G9 后半）：失衡比 `对方手数/本方手数 > 3 且差额 > 2×baseQty` 时，允许突破本方极值继续挂层——EA 用它解决双侧失衡。
3. **挂单跟踪**（G8）：每个 tick 重算"应挂价"，偏离现有挂单 ≥ `pendingTrailStepPct`（换算 10 点≈0.02%→取 0.05% 地板）时撤旧换新。回测里等价于逐 K 线重估；parity 说明见 §4。
4. **侧上限撤挡**（G11）：某侧已成交层数 ≥ maxLayersPerSide 时立即撤销该侧在挂单，防"挡单触发超帽"。
5. **保证金/敞口预检**（G11）：新单预计占用 = 名义/杠杆，要求 `availableMargin > 占用×1.15 && equity > 占用×1.25`（EA L1936 双系数原样；equity 用 `availableMargin + 未实现盈亏` 近似，口径以 P0-3 修复后为准）；不足即不挂并写 note——同时闭合审计 P0-2/P3-13 在马丁上的敞口口。ctx.availableMargin 已存在（types.ts L98），无契约改动。
6. **首 K 线锁**（G11）：`firstOrderMarket` 路径下，同一根执行周期 K 线内不重复市价开首层（替代现在脆弱的 20s 时间戳去重，回测语义也更干净）。
7. **出场 arm 即撤挂单**（G12）：篮子追踪进入 arm 状态后，每 tick 维持"该侧无挂单"，防止追踪途中又铺新层摊薄利润。
8. **触发价距离地板**：STOP 触发价距判定价的最小距离参数化 `minTriggerDistPct`（tickSize 取整 + 0.05% 地板）。EA 的 `StopOrderMinDistancePoints`（freeze/stop level + 点差 + 5 点延迟 + 3 点安全，L1868–1920）是 MT5 概念，标记价触发的币安 algoOrder 无对应物，简化为此单一参数。

### M4 出场优先级链（TryAutoCloseLogic 完整展开）

按 balance 的**短路顺序**重构 `onTick` 出场段：

```
1) 首单追踪：仅当全篮子只有 1 个 Lot 且开仓后 ≤ firstTrailBars 根 K 线内
   净收益 ≥ triggerMoney(=step 换算额) → arm；价格回撤 trailStep → 平
   （G7：15s/50/25 点 → 根数/ATR% 等价改写，C-1 约束下唯一诚实的做法）
2) 篮子追踪：arm 条件 = netPct ≥ basketStart() 且 netUsdt ≥ target + trailTrigger
   离场条件 = 价格（判定基准价）自峰值回撤 ≥ trailStepPct（G14 双口径）
   arm 期间维持空挂单（M3-7）
3) 分侧均值目标平仓（G5）：某侧 净收益 ≥ sideTarget(该侧) × 层数 时，
   震荡域 → 直接平该侧；中性/趋势域 → 若对侧为空可平，否则转配对减仓
4) 趋势保护配对减仓（G6）：盈利侧一单 + 亏损侧一单各**全平**（Lot 不可
   分割，EA 的"配对 volume"退化为两单手数——选对时优先手数差最小，
   净敞口漂移过 M3-5 预检兜底）；排序键照搬 EA：亏损侧不利距离最深
   优先、同距亏得多优先（L2488–2491）；趋势域防护：优先配"保护类型"
   之外的对，保护对须满足 EA 判据换算（L2415–2441）；配对平之前
   撤全部挂单并重估（EA L2405/2520 的两段式 EstPair→撤→再估语义）
5) 兜底：篮子固定止损/止盈（USDT 口径，现有）保留为最外层保险
```

每层出场写清 `LotExitReason`：篮子/侧目标→TAKE_PROFIT、配对减→SIGNAL（note 标 pair）、首单追踪→TAKE_PROFIT。归因不混记（shared/position.ts 哲学注释）。

口径差声明：EA 的 `TrailingNetProfitAfterCosts` 扣的是"点差+滑点预算"（其 POSITION_PROFIT 已含佣金），我们扣预估 taker 平仓费——我们的口径更保守且与结算链路同源（EXIT_FEE_RATE 单一真值），**保留我们口径，不回改成 EA 口径**。

### M5 方向闸门融合（resolveSides 升级）

保留我们的单侧金字塔四分支骨架，两处换血：
- "都没有持仓 → 评分定向"从 tanh 轻量分换成 M1 的 `{score, dir}`：优先用粘滞 `dir`（域机自带防抖），`dir=0` 时才看 score 符号——比裸 score 定向少挨两次打脸。
- 加入 **pivot alarm**（L3442–3456）：单侧深浮亏（浮亏 < −max(50U, equity×PivotLossPct=5%)）且近 `pivotLookback` 根 K 线累计逆行 > `pivotMomPct` → **放行双侧 carry**（不平老仓，反向侧开新单，靠配对减/篮子慢慢带走）——这是 EA"立刻掉头但不止损"的原教旨形态，与 C-3 一致。动量口径用 K 线累计涨跌幅替代 30s 环形缓冲（C-1）。

### M6 增强项：yuanliu 三层极端熔断

（初版方案 M2 内容不变，此处摘要）ATR/中位数尖峰 ≥2.0 → 暂停新开与加层（不动出场）；量价方向门 0.30；单根大实体 ≥2×ATR 拦截反向侧挂单。作为 E6 单变量实验接入，默认关。

### M8 新策略载体与「策略运行状态」区设计（与 W5 同迭代交付）

**载体 = 新增独立策略，不改老策略**：
- `name: martingale_grid_v2`、`label: 马丁网格V2 · King内核`（可再定名）；文件 `martingale-grid-v2.strategy.ts`，manifest `strategies/martingale-grid-v2/`。老 `martingale_grid` 原样保留，继续充当 E0 基线与回滚锚。
- 好处：新旧可同标的 A/B 并行（P2 多实例 instanceId=`策略名:交易对` 天然支持）；闸门产物（research/DSR）按策略独立注册，互不污染；回滚 = 停实例，不需代码回退。
- 注意：两策略同跑共用同一实盘账户的保证金与权益，A/B 期必须一侧 live 另一侧模拟撮合、或双方都用小 baseQty——记入实验台账。
- 注册接缝：策略文件 + manifest（含风险提示/能力声明）+ registry 注册 + 上架闸门（E 系列产物未达前不合 live 闸，可模拟室跑）。

**前端范围收敛**：不做全局重设计。策略列表/当前参数表单是 schema 驱动自动渲染（新策略零改动）；唯一需要设计的是详情页的**「策略运行状态」区**（现截图中红框位置）——v2 决策面信息翻倍，这块必须回答三个问题：**Brain 现在怎么看市场、两侧网格各在等什么、出场链正逼近哪条线**。

**① 数据契约**：`getState()` 输出结构化快照（state 字典原样透传，shared/dto/api.ts，无 DTO 改动）：

```
{ stateV: 2,
  note, basketPeakPct,          // 顶层保留通用兜底字段：移动端/列表卡片只读这两个，零改动
  regime: { score, dir, stateText(七态), chop, coherence, conflict, frames:[{mult, score, trendiness}], calibrated },
  grid:   { perSide: { long|short: { layers, lots, stepNow, multNow, nextAddAt, target, progressPct, pending:[{price,qty,followTarget?}], ladder:[{layer,price,qty,filled}] } },
            exposure: { netLots, grossNotional, marginOccupy, guardRemainLayers, pivotAlarm } },
  exits:  { basket: { netUsdt, netPct, peakPct, startNow(动态启动线), trailArmed, retraceExitAt },
            side:   { long|short: { targetUsdt, hit } },
            pair:   { candidate: {profitLotId, riskLotId, allowed, why} | null },
            firstTrail: { active, windowRemainBars } }
}
```

老策略 state 无 `stateV` 字段——前端据此分流，其它策略现有展示零影响。

**② 运行状态区布局**（新组件 `MartingaleV2Status.tsx`，详情页检测到 `stateV===2` 时渲染，否则走现有展示分支）：

- **状态带**（卡片顶部一行）：七态彩色标签（震荡灰/弱黄/确认蓝/强紫，复用 StatusBits 范式）+ score 横向仪表（−100~+100、零线居中、当前值游标）+ chop/coherence 小字 + 最近动作 note + **暂停指示徽章**（funding 窗口/极端熔断/保证金护栏——哪个闸在拦新开，红底可 hover 原因）；
- **三列**（窄屏堆叠）：
  1. **市场理解**：三框架迷你柱（1×/5×/15× 各自 score·trendiness）+ hover 展开六因子明细——回答"为什么只放这一侧"；
  2. **网格**：多/空双列——层数/手数、**当前实际间距与倍率**（评分驱动化后逐 tick 变化，不显示就是黑盒）、阶梯（已成交高亮、挂单跟踪中的标"↝ 将跟至 x"）、下一层触发线；pivotAlarm 时双列同时高亮"carry 模式"；列底敞口护栏（净敞口、保证金占用、剩余可挂层数）；
  3. **出场**：篮子三线横条（netPct vs 动态启动线 vs 回撤离场线，峰值游标）+ 分侧均值目标进度条 ×2 + 配对减仓候选对（含防护拒绝原因，消除"为什么不平那对"的不可解释态）+ 首单追踪窗口倒计时。
- **空态**（未运行，即截图现状）：保留现有引导文案，补一行机制简介（Brain/出场链/护栏各一句话），让用户启动前就知道它与老马丁的区别。

**③ 验收**：按项目规范驱动浏览器自动化，覆盖运行态三列、空态、carry 模式与暂停徽章的触发态。

### M7 明确不移植清单及理由

| 项 | 理由 |
|---|---|
| HedgedUnwind（yuanliu） | 锁仓把爆仓换成阴跌+双份手续费/资金费，账面曲线改善是归因错觉（初版 M5 结论维持） |
| TryFastScalpClose | balance 中无调用点，作者已弃用的死代码 |
| EquityScale 复利缩放 | balance 默认 cap=1.0（作者实盘也关）；且强依赖权益口径，P0-3 未决期不碰，列为 v2.1 候补 |
| LiquidityZones 整套 | 依赖 tick 级触发带/跟踪平移与经纪商点值，违反 C-1 的性价比；BTC 关键位逻辑另行立项 |
| MT5 点值/价差体系（PricePointScale、MaxSpread 点数） | 换算成 %/ATR 后无对应物；BTC 用 taker/maker 费率与标记价 |
| 新闻/会话时段/周五收摊/每日目标 | MT5 外汇时段语义；BTC 24/7 对应物=funding 结算窗±15min 暂停开层 + 周末薄流动性降杠杆（已并入 M3-5 的 pauseAroundFunding） |
| 30s 自建 K 线环形缓冲原样 | 时序外设；仅取其"短周期动量"语义做 M5 pivot |

---

## 4. 回测台配套需求（SimBroker / 引擎侧）

移植后策略决策面依赖以下引擎能力，W6 逐项核对补齐：

1. **STOP 挂单撤换**（M3-3 挂单跟踪）：现有事件驱动引擎已支持 STOP 触发（donchian v2 验证过），需补"同一 tick 撤+重挂"的当根不触发语义（新单从下一根开始判触发，防前视）。
2. **判定基准价**：STOP 触发与篮子/侧目标判定统一用标记价口径（triggerPriceType），与实盘 algoOrder `workingType=MARK_PRICE` 对齐；标记价数据由 interval K 线 close 近似——如实记录该近似，live/dry 对账时验证偏差（呼应 P1 parity 系列）。
3. **配对减仓结算**：closeLot 单 Lot 全平已支持，无引擎改动；报告层需按 reason 聚合出"配对减"现金流。
4. **重采样一致性**：M1 的 5×/15× 框架由 1× 序列聚合，回测/实盘共用同一纯函数——天然 parity。
5. **挂单跟踪的诚实声明**：EA 是 5s tick 级追价，我们是"每 tick/每根 K 线收盘后重估"。两者语义相近但不逐位相同；这正是 C-1 允许的"改写为 K 线可判定等价形式"，live 与 backtest 走同一份代码即可保证引擎间一致，残余风险由 E 系列的 dry-run 对账覆盖。
6. **触发时机粒度差（已知、不在本次修复）**：回测里挂单跟踪"onTick 撤换 → 下一根才参与 high/low 触发判定"（SimBroker beginBar 语义，已核对 L158–178 与本 bar 放置不判触发一致），而实盘 algoOrder 挂出后标记价穿越**当秒即触发**；回测判定用 bar 极值近似、实盘用真实标记价流（runner L90 `mark = bar.close`）。这两条是既有 P0/P1 parity 的已知组成，v2 不新开修复项，只要求 E 系列实验结论在 dry-run 对账中复核（不复核即不得上 live）。

---

## 5. 参数换算表（新参数全量注册四处接缝）

| 新参数 | EA 原型 | 换算规则 | 默认 |
|---|---|---|---|
| regimeTfMults | M1/M5/M15 | ×runtimeInterval | [1,5,15] |
| trendRange/Confirm/Strong | 20/45/70 | 无量纲原样 | 20/45/70 |
| trendDirEnter/Exit/chopGate | 26/14/0.58 | 无量纲原样 | 26/14/0.58 |
| kStepTrend/kStepCounter | 120→90 / 140→150 | 斜率 −0.25/+0.083 | 0.25/0.083 |
| trendMultMin | 1.10 | 原样 | 1.0（保守贴冠军教训） |
| basketAmpK | ×(1+0.8s) | 原样 | 0.8 |
| sideTargetPct | 2.5$/0.01手 | 侧均值目标改为**该侧名义的比例**：2.5$≈0.01手×40k×0.625%→ 折 0.6%×层距归一 | 0.006 |
| trailTriggerPct / trailStepPct | 50/25 点 | 点→ATR%：≈0.5×step、0.25×step | 0.5×/0.25×step |
| firstTrailBars | 15s | 15s≈1/4 根 M1 → 执行周期取 1 根 | 1 |
| pendingTrailStepPct | 10 点 | 0.02%→成本地板 | 0.05% |
| rebalanceRatio | >3.0 & >0.2手 | 原样 + 绝对量 2×baseQty | 3.0 |
| pivotLookback/pivotMomPct | 10×30s=5min, $1.5 | 5min→根数；$1.5 金→0.25% BTC 涨幅 | 视 interval；0.0025 |
| pivotLossPct | 5% equity | 原样 | 0.05 |
| atrSpikeMult/volDirGate/bodyAtrMult | 2.0/0.30/2.0 | M6 照搬 | 2.0/0.30/2.0 |
| pauseAroundFunding | 新闻时段变体 | ±15min（UTC 0/8/16 结算） | true |
| minTriggerDistPct | StopOrderMinDistancePoints | 点值体系无对应 → 距离地板 | 0.0005 |
| marginGuardFree / marginGuardEquity | CanAffordOrder 1.15/1.25 | 无量纲原样 | 1.15 / 1.25 |
| pairMaxShare | 配对≤趋势侧30% | Lot 不可分模型下退化为选对提示，不作硬闸 | 0.30 |

新策略参数 = 老策略 20 参（同名同语义全量继承，基线可对账）+ 上表新增参数；所有新机制独立开关，关断态行为 = 老策略逐位一致（E0 回归基线）。老策略本身零改动。

---

## 6. 闸门实验序列（C-2：一次只进一个机制）

前置：P0 系列（周期 parity/权益口径）修复已并入其他线，E0 起全部用修复后引擎跑。

| 实验 | 内容 | 通过门槛 |
|---|---|---|
| E0 | 基线：新策略全开关关闭跑同一语料，与老策略 `martingale_grid` 同语料报告对账 | diff=0（新旧行为一致回归，证明基线继承无走样） |
| E1 | +M1 Brain（仅替换定向与域机，间距/倍率/出场不动） | WF OOS Sharpe >0 且较 E0 不衰减；DSR≥0.95 |
| E2 | +M2 三件套（间距/倍率/目标评分驱动化） | OOS maxDD<10%；深套回放表"最长套牢时长"较 E1 缩短 |
| E3 | +M3 挂单纪律（含恢复 2 格回归确认、挂单跟踪） | 成交笔数与单轮周期无恶性变化；费率占比不升 |
| E4 | +M4 出场链（侧目标/配对减/首单追踪逐层开） | 每层单独过 A/B；篮子全平占比下降且总收益不降 |
| E5 | +M5 pivot 双侧 carry | 单边行情段回撤不劣化；震荡段轮次加速 |
| E6 | +M6 三层熔断（yuanliu 增强） | 2024-03/2025-10 等插针窗口专项改善 |
| E7 | 全开 + 参数 plateau 扫描（±20% 邻域） | plateau≤20%；任一机制在终态消融实验中贡献为负则回退 |

每个实验固定语料：≥3 年 1m 数据聚合多周期、≥2 个独立执行周期（15m/1h）各跑一遍——**跨周期存活才算数**（P0-1 教训）。深套回放表随每份报告常驻（C-3）。

---

## 7. 工作包与排期

| W | 内容 | 产出 | 预估 |
|---|---|---|---|
| W0 | 新策略注册骨架：`martingale-grid-v2.strategy.ts`（先克隆老策略行为，全部新机制开关默认关）+ manifest + registry + schema 表单自动上架验证 | 可启动可回测的壳 | 1d |
| W1 | shared 指标原语：回归斜率×R²、带符号 Kaufman ER、ADX±DI、Choppiness、MACD 柱、Donchian 强度 + 单测 | `indicators/core.ts` 扩充，build 生效 | 1.5d |
| W2 | MarketRegime 模块（六因子/融合/平滑/域机）+ 固定 fixture 单测（对齐 EA 手算样例） | `strategy/lib/market-regime.ts` | 2d |
| W3 | M2 三件套纯函数 + 策略接线（开关默认关） | 间距/倍率/目标驱动化 | 1.5d |
| W4 | M3 挂单纪律七项改造 | ensureSide/ensureGrid 重构 | 2d |
| W5 | M4 出场优先级链 + M5 方向闸门融合 | onTick 出场段重写 | 2.5d |
| W6 | 回测台配套核对（撤换语义/标记价判定/重采样/报告聚合） | SimBroker diff + 单测 | 1.5d |
| W7 | M6 三层熔断（yuanliu 增强） | 独立开关 | 1d |
| W8 | E0–E7 实验序列执行 + 报告 | 闸门结论 + 终态参数 | 2.5–3d |
| W9 | 文档/manifest 文案/注册接缝四处同改核查 | 注册完整 | 0.5d |
| W10 | M8 运行状态区：stateV:2 协议 + `MartingaleV2Status` 三列组件 + 空态简介 + 浏览器自动化验收 | 面板不盲飞 | 1.5d |

合计 **18–19 天**。顺序 W0→W1→W2→W3（可并行 W4）→W5→W6→W7→W8→W9→W10；W8 若 E1 不过闸，止步于"仅骨架修正（G9/G10/G12 回正）+ 护栏（M3-5）"交付，其余开关封存——Brain 证伪本身就是有价值的结论。

## 8. 风险声明

1. **多重比较**：E1–E7 七次实验即 DSR 的分母来源，全部实验记录进同一台账，DSR 按累计尝试数计算，对齐 deflated-sharpe.ts 的 0.95 标准，不迁就 0.5。
2. **等价改写残差**：G7（15s）、G8（5s 追价）的 K 线化改写与 EA tick 行为存在不可消除的粒度残差；以"引擎间一致 + dry-run 与交易所对账"兜底，不假装逐位还原。
3. **移植走样再发风险**：G9（1 格 vs 2 格）证明语义复制极易悄悄走样，W2–W5 每个模块必须携带"EA 行号锚点注释 + 手算用例"，评审对照源码验收。
4. **马丁终局仍在**：以上全部改造改善的是存活与轮转速度，不改变"左尾风险换右尾收益"的结构；篮子止损、净敞口上限、funding 窗口闸门照常常驻，深套回放随时可读。
