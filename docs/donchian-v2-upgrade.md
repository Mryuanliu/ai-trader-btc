# 唐奇安策略升级版（Donchian v2）：从"几十天一次突破"到高频率趋势交易系统

- 日期：2026-10-05
- 状态：方案（未开工，批准后按里程碑实施）
- 前置调研：`docs/breakout-frequency-research-2026-10.md`（机构做法与学术证据）
- 代码基线：`apps/server/src/strategy/donchian-breakout.strategy.ts`（v1.0.0，359 行，onTick 单通道突破 + 反向通道/吊灯/时间三段出场）

## 1. 问题定义

现版（1h 周期、brk=55~80 正向高原）的结构性缺陷：**单一长回看通道 = 信号极稀**。
实跑观测：`价格在通道内 [83178.00, 87055.60]，未突破` 连续多日无动作；3 年回测里 A 段（2023-10→2025-03）brk=80 仅个位数交易。**频率低的直接后果**：样本少 → DSR 被结构性压低（低频失效）、资金长期闲置、用户对"是否在工作"失去可观测感。

**已证伪的错误提频方向**（不重走）：
- 换短单通道（brk≤30）：3 年 A 段亏损；
- 下沉 5m/1m：1m 月内 1809 笔费后 -100%，成本地板碾平；
- 结论：提频必须走"**多信号源并行 + 单事件多笔执行**"，而非"更快触发"。

## 2. 升级总览：四个模块，各自独立开关、独立验收

| 模块 | 一句话 | 频率贡献 | 证据源 | 里程碑 |
|---|---|---|---|---|
| M1 通道集成 Ensemble | 多条不同回看通道投票出目标仓位 | ★★★（首仓即触发） | Concretum SSRN 5209907（crypto Sharpe>1.5）；Tzotchev SSRN 4677166；海龟 S1/S2 | P0 |
| M2 顺势加仓金字塔 | 一次突破吃满一轮趋势，½~1×ATR 阶梯加层 | ★★（事件变回合） | Way of the Turtle 4-unit 阶梯；future-short-grid 分层数组 | P1 |
| M3 量能确认 + 假突破反手腿 | 突破成败两类行情都有单可下 | ★★（覆盖另一半行情） | For Traders 2026 实测：1h 失败率≈50%、BTC≈65%、量能 <1.5×均量多为扫荡 | P2 |
| M4 斜率定时机 | 开仓额外要求短均线斜率同向，拒绝"半山腰追单" | ☆（提质不提量） | future-short-grid calcAngle（5m MA5 斜率闸）思想 | P2 |

设计原则：**每个模块一个 boolean 参数开关，默认关**；升级逐个用回测台「双模式对照」证明独立贡献后才默认开——这是防过拟合的硬约束（每加一层都要有统计功劳，没功劳不上车）。

## 3. 详细设计

### M1 通道集成（核心）

**参数**：`channelPeriods: number[]`（默认 `[20, 55, 80]`，schema 限 2~5 条、每条 5~200），替代标量 `breakoutLookbackBars`（保留兼容：数组长度 1 时退化为 v1）。

**信号合成**（onTick 第 3 步替换）：
- 每条通道 i 出信号：`mark > upper_i → +1`；`mark < lower_i → -1`；否则 0；
- `targetUnits = round(avg(signal_i) × maxUnits)`，maxUnits=M1 与 M2 的公共上限（默认 3）；
- **当前持仓 units < targetUnits → 开一层；> targetUnits → 平最外层**（信号均值下降本身就是出场动力，替代部分反向通道职能）。

**频率机理**：20 通道先破 → 1/3 仓进场；扩到 55、80 通道相继破 → 逐日加满。震荡回归时短通道信号先退，仓位自动缩——**假突破从"满仓止损"变成"1/3 仓试错"**，这正是 ensemble 在 Concretum 论文中 Sharpe>1.5 的原因：不是提胜率，是把单次错误的代价除以 3。

**出场适配**：`exitLookbackBars` 语义改为"仅约束最后一层"（层 i 按各自通道下沿退出），吊灯/时间止损逻辑不动（decideExit 已按 lot 遍历，天然兼容多层）。

### M2 顺势加仓阶梯

**参数**：`pyramidAtrStep`（默认 0.75，加层间隔 = 该倍数 × ATR14）、`maxLayers`（默认 3，manifest `suggestedMaxLayers` 从 1 改 3）。

**逻辑**：已有持仓且趋势方向信号仍在（ensemble 未反转）时，价格自上一层成交价顺势推进 `pyramidAtrStep×ATR` → 开新层；每层独立吊灯（现有 `chandelierStops` Map 按 lot.id 天然支持）。
**风控底线**：全部层合计名义敞口仍受 `riskPerTradePct` 逐层折算约束（每层独立定标，不加杠杆叠仓）；**绝不照抄 future-short-grid 的无限扛单**——它没有止损，我们有吊灯+时间+反向通道三段出场，保留。

### M3 量能确认 + 假突破反手（fade leg）

**参数**：`volConfirmMult`（默认 1.5，0=关闭量能确认）、`fadeLookbackBars`（默认 5，0=关闭 fade 腿）。

**量能确认**（开仓前）：突破 bar 的 `candle.volume < volConfirmMult × 近 20 根均量` → 本次突破只记 note 不追（实测依据：BTC 假突破里大多数是低量扫荡）。`Candle.volume` 已贯通全链路（1m 归档→SQL 聚合 1h 的 sum(volume)→回测喂线），无需数据改动。

**fade 腿**（持仓中）：进场后 `fadeLookbackBars` 根内 mark **收回突破前通道内** → 判假突破：
1. 平掉该突破仓（止损语义，reason=STOP_LOSS）；
2. 反手开 fade 仓：方向=回滚方向，止损=假突破极值（插针顶点），目标=通道中轨；
3. fade 仓同样受吊灯/时间止损管辖，冷却 `cooldownSec` 生效。

**新闻日过滤（可选开关 `skipHighImpactDays`）**：FOMC/NFP 日期望恶化有实测依据，但**StrategyContext 当前无新闻字段**——接线需 runner 注入或日历缓存下发，属平台层改动，单独评审后再做，不混入策略包。

### M4 斜率定时机

**参数**：`slopeFilter`（boolean，默认 false）。
开 LONG 需 `MA5(closed)` 斜率 ≥ 0，开 SHORT 需 ≤ 0（用已收盘 close 计算，与 calcAngle 的"正在拉伸不追"反向：**我们要求顺方向缓升而非逆势尖拉**）。作为 M3 质量增强项一起验证，不单独提频。

## 4. 回测台接口与工程接缝（均为已核实存在）

- **双模式对照**：`compareKey` 填 `useEnsemble` / `usePyramid` / `useFade` 各跑一轮 TRUE/FALSE（已知 P2 静默 no-op 已由并行会话修复：doCompare 前置校验参数名必须在策略参数集内并提示可用布尔开关清单，见 AdminBacktest.tsx；M1 落地时新开关会自动出现在该提示候选中）。
- **sweep 约束**：单窗口 540 天上限 → 三年分 A/B 两段（与 donchian 既有验证同法），`channelPeriods` 走枚举组合而非笛卡尔网格（sweep 对数组参数按预设 3 组：[20,55,80] / [10,30,90] / [20,40,80]）。
- **闸门闭环**：v2 以新策略名 `donchian_breakout_v2` 上架（v1 保留在跑做基线），research 达标后写 backtestRef，走上架治理闸门（DSR≥0.5、OOS Sharpe>0、OOS 回撤<10%）。
- **运行时**：`runtimeInterval` 保持 1h；交易日志（trading-journal）自动记录每层 OPEN/CLOSE，无需改动。

## 5. 验收判据（全部满足才算升级成功）

以 v1 冠军基线（1h，brk=80/exit=20/chandelierK=4，A 段 +17.06% / B 段 +14.49%）为对照：

| 维度 | M1 门槛 | M1+M2 | M1+M2+M3 |
|---|---|---|---|
| 交易笔数/年 | ≥ 基线 ×2 | ≥ ×3 | ≥ ×3 |
| 费后总收益（两段） | 均 > 0 | 均 > 0 | 均 > 0 |
| 最大回撤 | ≤ 基线（-16~-20%） | ≤ -12% | ≤ -12% |
| walk-forward OOS | Sharpe>0 且回撤<10% | 同左 | 同左 |
| DSR（sweep 全网格） | ≥ 0.5 | ≥ 0.5 | ≥ 0.5 |
| 单模块增量 | — | 双模式对照显示 pyramid TRUE 组回撤/收益占优 | fade 组在假突破集中期回撤显著更低 |

任一模块未达门槛 → 该模块默认参回退关闭，不阻塞其余模块上架（模块间通过开关解耦的意义所在）。

## 6. 实施顺序

1. **M1 + 单测**（ensemble 信号合成纯函数化，`__tests__` 覆盖分歧/共识/退化 v1 等价三类用例）→ 回测台 BKT 验证 A/B 两段 + research；
2. **M2 加仓**（含 `suggestedMaxLayers` 与篮子展示适配）→ 双模式对照；
3. **M3 量能+fade**（先量能确认后 fade 腿，分两步提交）→ 双模式对照；
4. **M4 斜率**（最后，若前面已达标可不做）；
5. 每个里程碑完成：浏览器全链路验证 + 落 `.codebuddy/memory/` + 更新本文档状态。

## 7. 风险与禁忌（写死在文档里的红线）

- **不缩短基础周期到 5m/1m**：成本结构已两轮证伪；
- **不学 future-short-grid 的无止损结构**：它的"月化 15%"是震荡市幸存者样本，其状态文件对账缺失、无幂等等工程缺陷全部不采纳，只借"斜率定时机"思想；
- **不为提频放宽 `atrMinPct` 低波过滤**：BTC 1h 假突破率 65% 是市场特征，任何"多信号"方案都要以回撤口径验收；
- **一次只上一个默认值变更**：v1→v2 迁移时 `breakoutLookbackBars` 旧参数继续可填（兼容层转换），存量运行实例不停机不回溯；
- ~~已知 P1 缺陷（详情页 DSR 徽标读错字段）~~ **已修复**（并行会话改为 `strategy.backtestRef ?? strategy.manifest?.backtestRef` 双源兜底，已核实代码），验收可直接看详情页徽标。
