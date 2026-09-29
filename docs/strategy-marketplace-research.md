# 策略市场与稳定盈利模板策略 · 调研与设计（评审稿）

> 状态：**调研/设计稿，不改代码**（2026-09-29）
> 定位重申：本平台坚持「**托管多方策略的市场**」定位不变——平台负责绑定交易所/下单/记账/行情/绩效，策略负责交易逻辑。
> **本阶段范围（2026-09-29 收敛）**：只做「**开仓（方向性）策略盈利**」——靠判断方向开仓并管理仓位获利。资金费率套利/基差/跨所/配对/做市属「市场中性·独立模式」，**本轮暂缓、整体后置**（需现货腿/funding 数据/双腿对冲，且当前 demo 无法验证真实收益），相关章节已标【后置】并保留备查。
> 本文目标：① 系统调研市面主流开源方案，明确「借鉴什么、改造什么」；② 给出一份**可稳定盈利的模板策略目录（Catalog）**；③ 规划承载这些策略所需的**平台能力演进路线**。
> 关联文档：`strategy-platform-plan.md`（平台化 P0–P4）、`strategy-dev-guide.md`（策略 SDK 契约）、`slim-martingale-refactor-plan.md`、`trading-audit-notes.md`。

---

## 0. 一页纸结论

| 维度 | 现状 | 目标 |
|---|---|---|
| 策略品类 | 2 个方向性（马丁网格、趋势跟踪），**互相高相关、都靠天吃饭** | 扩充**方向性开仓策略族**（趋势/动量/突破/均值回归/事件）+ **跨周期·跨标的分散** |
| 「稳定盈利」 | 单一趋势/动量长期 **Sharpe≈1.0~1.3、回撤 30%+** | 用**波动率定标仓位 + regime 门控 + 移动出场 + 信号分散**把方向性做平滑（目标组合 Sharpe 1.5~2、回撤<20%） |
| 契约能力 | 单 symbol、单周期、固定金额下单 | **仓位/风险引擎（L1，本阶段最核心）** + 多周期/多标的只读 + ATR 移动出场 |
| 评价体系 | `src/backtest/` 已空，只剩历史 json | 严肃回测台（walk-forward + purge）+ 实盘 track record |
| 市场运营 | 有 manifest（版本/风险/能力声明） | 策略**分类 taxonomy** + 适用市况标签 + 上架审核标准 |

**一句话**：只做方向性时，「稳」不靠预测更准，而靠 **波动率定标仓位（第一杠杆）+ regime 门控 + 移动出场 + 跨周期/标的分散 + 回测防过拟合**。瓶颈仍是：①没有仓位/风险引擎（下单按固定金额、不按波动率）②没有回测台就无法证伪「稳」。

---

## 1. 核心命题：只做方向性，「稳定盈利」从哪来

> **本阶段范围**：只做「开仓（方向性）策略盈利」。下面 §1.1（资金费/市场中性）仅作**【后置·备查】**；主线是 §1.2——**在不与大盘方向解耦的前提下，如何把方向性做得尽量稳**。

**方向性的现实天花板**（学术实证、非厂商口径）：单一时间序列动量/趋势长期 **Sharpe ≈ 1.0~1.3、最大回撤 ~34%**（Moskowitz-Ooi-Pedersen，Quantpedia 收录：年化 alpha 20.7%、波动 15.7%、Sharpe 1.31、DD −33.9%）；且**金融危机后 4 年趋势回报减半**（Hutchinson-O'Brien）。→ 所以方向性的「稳」靠 6 个**可工程的杠杆**（§1.2），而非「更准的预测」。

原市场中性/方向性行业对比（2025 全行业实证，CoinEdition / Bybit Institutional / AIMA-PwC，数值偏乐观需打折）：

| 策略类型 | 2025 收益 | Sharpe | 最大回撤 |
|---|---|---|---|
| 市场中性基金 | **+14.4%** | — | — |
| 方向性基金 | -2.5% | ~0.80 | 常 30%+ |
| 基本面基金 | -23% | — | — |
| Delta 中性 | 全年 12 个月为正 | 2.39 | **0.80%** |
| 资金费率套利 | 「6M 115.9%」是研报口径，**实测远低**（见 §1.1） | ~4.84（基差） | ≤1.92% |
| 统计套利 BTC-ETH | 年化 14.89% | 2.23 | 低 |

> ⚠️ 上表是**厂商/研报口径、系统性偏乐观**（尤其资金费套利的 115.9%）。真实量级**以 §1.1 交易所实测为准**。

**判据**：稳定盈利 = **高 Sharpe（风险调整后收益）+ 低最大回撤 + 收益来源与大盘方向解耦**。
- 方向性策略赚的是「预测对涨跌」的钱 → 天花板低、尾部风险大。
- 市场中性赚的是「资产间关系/结构」的钱（资金费、基差、价差回归、买卖价差）→ 才是「无聊地稳定复利」。

**对现有两策略的诚实定性**：马丁网格 = 逆势加仓、无平台级止损、负偏尾部风险（审计里「35 个超上限 Short Lot」即成因）；趋势跟踪 = 震荡市被反复打脸。二者都应保留为「方向性品类」，但**不能当作稳定盈利主力**。

### 1.1 【后置·本阶段不做】资金费率套利 交易所实测校准（别信 §1 表里的 115.9%）

Binance BTCUSDT 永续资金费（截至 **2026-09-24**，取自 Binance 公开 funding-rate API）：

| 口径 | 年化 | 备注 |
|---|---|---|
| 近 30 天均值 | **6.82%** | 当前牛市窗口、多单旺盛，funding 偏高（对 C1 有利） |
| 近 12 月均值 | **3.40%** | 12 个月里 **23% 的结算周期为负** |
| 2026-02~04 | **−0.83 / −1.09 / −2.16%** | **连续三个月转负**，delta 中性空单反付钱 |
| 12 月内单周期峰值 | **≤ 0.01%/8h** | 教科书爱写的 +0.05%/8h(≈55% 年化) 全年**没出现过** |

- **含费测算**（双腿各 0.05%/笔，开+平共 4 笔）：30 天均值下约 **10.7 天回本**、30 天净赚 ~$360 / 占用 ~$133k 本金 ≈ **5.1% 年化（费前）**——资金占用是真实成本。
- **跨所版**：同期 Hyperliquid BTC funding 年化 **9.32%** vs Binance 6.82%（Hyperliquid 每小时结算、默认 0.00125%/h）——价差真实存在，但两套保证金账户 + 搬仓延迟是硬约束。
- **dated 基差（C2）**：Deribit 2026-12 BTC 期货仅高于指数 1.26%（≈5.0% 年化）、2027-09 ≈5.3% 年化——基差已被打到个位数。

> **校准后的诚实预期**：资金费/基差类「稳定盈利」= **个位数~低双位数年化（毛 3~9%、费后 4~8%）+ 极低方向回撤**，**且会在 funding 翻转期连亏数周~数月**。它的价值是 **高 Sharpe + 可复利 + 与涨跌解耦**，不是绝对收益率。谁把 115.9% 当 KPI 谁就会被教育。

### 1.2 方向性「稳定化」的六个杠杆（本阶段主线，按性价比排序）

> 核心实证：**方向性的收益质量主要由「仓位与风控」决定，而非入场信号本身**。Kim-Tse-Wald 发现 TSM 的 alpha 主要来自**波动率缩放（risk parity）**——去掉波动率缩放，月 alpha 从 1.27% 掉到 0.41%。这决定了下面的优先级。

| # | 杠杆 | 为什么能变稳（实证） | 平台/策略落点 |
|---|---|---|---|
| L1 | **波动率定标仓位**（inverse-vol / vol-targeting） | 同一信号，波动率缩放是 Sharpe 第一驱动（Kim-Tse-Wald；Barroso-Santa-Clara 恒定波动缩放年化 15.3% 最高效）；**「趋势平滑权益曲线、显著降回撤」的核心手段** | 平台**仓位引擎**：`notional = 风险预算 / ATR%`，取代固定金额下单（R0，本阶段最重要） |
| L2 | **regime 门控**（趋势市只做趋势、震荡市只做回归/网格） | Safari-Schmidhuber：市场在「小时~数年」尺度趋势、更短/更长尺度回归；**错市况用错策略=反复打脸**（现趋势跟踪震荡市亏损的根因） | ADX/ATR 比/已实现波动分位判 regime；非匹配市况空仓（R5） |
| L3 | **非对称/移动出场**（ATR 吊灯 chandelier、分段止盈、时间止损） | LeBeau Chandelier 随最高价上移锁盈；**「Taming of the Skew」：仅靠随时间调节风险敞口，正 Sharpe 组合即可做到正偏度** | 出场用 ATR 追踪而非固定止盈（freqtrade `use_custom_stoploss`，R2） |
| L4 | **跨周期 + 跨标的分散** | Baltas-Kosowski：月/周/日动量**互相关很低=捕捉不同延续现象**；「barbell」短+长期优于堆中期（Etienne 2025） | 契约需**多周期+多标的只读**（R1 重定向到「分散」）；runner 已支持多实例并行 |
| L5 | **信号做减法（防过拟合）** | Valeyre 2025：**单个 EMA 近似最优，堆一堆指标=cherry-picking**；TSM 对**起始日高度敏感**（Maymin）——晚一天上线可能由盈转亏 | 上架用 **Deflated Sharpe + CPCV** 把关（R4）；偏好简单稳健参数区 |
| L6 | **连亏/回撤熔断（protections）** | 单策略再稳也有 30%+ 回撤期；freqtrade protections 是社区共识的「稳」下限 | SDK `onProtection`（R5）：连亏 N 笔/回撤超阈→停该实例 |

**结论**：只做方向性时，「稳定盈利」的现实目标 = **组合级 Sharpe 1.5~2、最大回撤 <20%**，靠 **L1+L2+L4** 组合拳，而非幻想单一圣杯信号。资金费套利那类「与方向解耦」的稳定（Sharpe 2~5、DD<1%）**本阶段放弃**。

---

## 2. 开源生态深度调研

### 2.1 框架类项目一览

| 项目 | 语言 / License | 维护状态(2026) | 定位 | 对本平台最值得借鉴之处 |
|---|---|---|---|---|
| **freqtrade** | Python / GPL-3.0 | ✅ 活跃 · ~46K★ · 380+贡献者 | 方向性机器人 + 回测/超参 | 策略分层契约、**回调式风控**、**protections 熔断**、**FreqAI（实时 walk-forward 重训）**、**lookahead-analysis 自动抓前视偏差** |
| **NautilusTrader** | Rust 核+Python / Apache-2.0 | ✅ 活跃 · ~19K★ | 生产级事件驱动 | **回测/实盘同一引擎(parity)**、确定性回测、5M rows/s、16 场所含 Binance/Bybit——**P0 回测台架构标杆** |
| **QuantConnect LEAN** | C#+Python / Apache-2.0 | ✅ 活跃 · ~16K★ · 375K+ 实盘 | 全资产生态 | **survivorship-bias-free 点位(point-in-time)数据**理念、多资产多 Broker、社区算法库——数据卫生与生态参考 |
| **vectorbt** | Python / source-available | ✅ 活跃 · ~4.3K★ | 向量化研究/优化 | **参数网格/组合级秒级回测**做敏感性；无原生实盘(需配执行引擎) |
| **Superalgos** | JS/Node / AGPL(核对) | ✅ 活跃 · 社区自治 | 可视化策略 + **社交交易市场** | **最接近「策略市场」形态**：可视化设计器 + 回测 + 社区分享/复制榜——市场页/榜单运营参考 |
| **Passivbot** | Python / AGPL-3.0 | ✅ 维护 · 社区大 | 高频 **网格/DCA** | 现有马丁的「加固版」：safety 上限、geometric、**trailing 出场**、**min_profit 覆盖手续费**、硬止损 |
| **Jesse** | Python / MIT | ✅ 活跃 · ~7.4K★ | 加密策略/回测 | 简洁指标/多周期 API、回测即单测；**实盘需付费 Pro** |
| **OctoBot** | Python / GPL-3.0 | ✅ 维护 | 通用机器人 + 市场 | 评测/排名 UI 与「策略市场」运营形态参考 |
| **Qlib（微软）** | Python / MIT | ✅ 活跃 · ~37K★ | **AI 量化研究平台** | 完整 ML 管线(数据→训练→回测)、**RD-Agent 用 LLM 自动挖因子**——**仅研究不执行**；未来 ML 信号可借鉴 |
| **FinRL** | Python / MIT | ✅ 活跃 · ~14K★ | 深度强化学习交易 | RL(DQN/PPO/SAC)研究；**生产不稳定**，仅参考 |
| Hummingbot【做市/套利·后置】 | Python / Apache-2.0 | ✅ 活跃 | 做市 / 套利 | V2 三层架构(编排思想)；**A-S 做市本阶段不做** |
| ⚠️ **backtrader** | Python / GPL-3.0 | ❌ **弃维护**（作者已「完结」离场） | 通用回测 | 仅概念参考(order/fill 状态机)；**勿起新项目** |
| ⚠️ Catalyst / Blankly / PyAlgoTrade | — | ❌ 归档/停摆 | — | **反面教材：GitHub star ≠ 维护**，Catalyst 有致亏 bug |

### 2.2 架构范式：两套最值得抄的「分层模型」

**(a) freqtrade：策略 = 数据 + 信号 + 回调 + 保护（关注点分离）**
- `populate_indicators / populate_entry_trend / populate_exit_trend`：把「指标、入场、出场」拆成独立可测阶段。
- `informative_pairs()`：**一个策略可声明依赖多个 (pair, timeframe) 数据源**，框架自动下载并对齐合并——正是我们实现 **L4 跨周期/跨标的分散** 与 **L2 regime**（用高周期判趋势）缺的能力。
- 回调式精细化控制：`custom_entry_price`、`custom_exit`、`adjust_trade_position`（**动态加减仓**）、`leverage()`（**动态杠杆**）、`use_custom_stoploss` + `stoploss_from_open`（**移动/分段止损**）。
- `protections`：**连亏 N 笔/回撤超阈值 → 临时停用交易对或全局停机**（Cooldown / StopLossGuard / MaxDrawdown / LowProfitRatio）。这是「稳定」的关键工程手段，我们目前完全没有。

**(b)【后置·做市/套利】Hummingbot V2：MarketDataProvider + Executor + Controller 三层**（分层编排思想仍适用）
- **Market Data Provider**：历史 K 线 / 盘口 / 成对的**统一只读数据入口**（策略只读，不各自抓）。
- **Executor**：一个**离散、有生命周期**的下单工作流（Position / DCA / Grid / TWAP / **XEMM 跨所** / **LP 做市**），自管挂单刷新与撤销。→ 对应我们「一次开仓意图」，但把「部分成交/刷新/对冲腿」内聚成一个可复用单元。
- **Controller**：长期运行、编排多个 executor、按市况动态启停子策略。一个 bot 内并行多控制器 = 多策略并行。
- **借鉴结论**：我们的 `StrategyExecutor`（`openLot/closeLot/placeStopOrder/cancelOrder`）粒度太细且单标的；往「**Executor=有生命周期的交易工作流（如一个趋势仓位的建/加/移损/平）**、**Controller=按 regime 编排启停子策略**」演进——这正是 L2/L3/L6 的实现载体（双腿/对冲部分属后置）。

**(c) NautilusTrader：回测 = 实盘同一引擎（backtest/live parity）**
- 策略代码在回测与实盘**跑同一条路径**，只有数据源/时钟不同 → 根除「回测一套逻辑、上线另一套」的漂移。
- **我们的结构优势**：`StrategyContext` + `StrategyExecutor` 契约**已是策略的唯一入口**，只要补一个「用历史事件流回放、调同一个 `onTick`」的引擎即可天然 parity；很多开源 bot 回测/实盘是两套代码，我们从起点就该做成一套。

### 2.3 「策略市场」运营形态借鉴
- **OctoBot / 3commas / cryptohopper**：市场按**类别 + 风险等级 + 适用市况 + 实盘 track record（Sharpe/回撤/胜率）** 组织，用户按风险偏好筛选——不是只按收益率排。我们 `performance.service` 已产出这些指标，缺的是**上架展示层与分类标签**。
- 上架审核：内部策略走 code review（对应 `strategy-platform-plan.md` D3 方案 A），要求**必须声明 `capabilities` 与 `riskNotes` + 至少一个回测/前向样本**，否则不上架。

### 2.4 2026 生态 5 大趋势 → 对本方案的验证
1. **回测=实盘 parity 是全行业第一需求** → 直接印证我们把 **P0 parity 回测台**列为最优先（§5 R4）。
2. **ML 成 table stakes**（FreqAI/JesseGPT/Qlib RD-Agent/LEAN Mia） → 我们**本阶段不追 ML**（定位+可解释优先），但契约预留：回测台与数据接口按「未来可插 ML 信号」设计。
3. **Rust 取代 Python 走性能关键路径**（Nautilus 5M rows/s） → 我们**回测回放器/参数扫描要走量化/并行**（Node Worker 或 WASM），别逐 tick 串行。
4. **star ≠ 维护**（backtrader 15K★ 已弃、Catalyst 致亏） → **不绑定外部引擎，坚持 TS 全自研**，把工程押在自己的 parity 回测台上。
5. **Freemium 化**（Jesse Pro/vectorbt Pro/LEAN 云） → 印证「平台自研、模板即内容」的必要性：**核心回测/仓位能力不能被别人的付费墙卡住**。
> 数据/口径卫生：LEAN 的 **point-in-time/survivorship-bias-free** 与 freqtrade 的 **lookahead-analysis**（自动检测未来函数/前视偏差）是回测台必须内置的两道质检。

---

## 3. 现有平台能力盘点 vs 承载「稳定策略市场」的差距

地基已成熟（`types.ts`/`strategy-sdk.ts` 契约、`strategy-runner` 多实例、`strategy-hub` 目录化上下架、`performance.service` 指标、`exchange_incomes` 已同步资金费）。但要跑出「多且稳」的模板，有**五道硬缺口**：

| # | 缺口 | 现状证据 | 挡住什么（本阶段） |
|---|---|---|---|
| G1 | **数据面窄**：`ctx` 只有单 symbol 单周期 | `buildContextFor()` 仅取 `inst.symbol`；无多周期/多标的/regime 输入 | L2 regime、L4 跨周期/跨标的分散 |
| **G2** | **无仓位/风险引擎**：下单按固定金额、不按波动率定标 | `openLot` 固定 quantity | **L1 波动率定标（本阶段第一优先）** |
| G3 | **出场原语弱**：只有固定 STOP，无 ATR 移动/吊灯/时间止损 | executor 仅 `placeStopOrder` | L3 非对称/移动出场 |
| G4 | **无真回测台**：`src/backtest/` 已空 | 目录空 | 无法证伪「稳」、无法防过拟合（L5） |
| G5 | **无风控原语**：无统一熔断/止损抽象 | `strategy-platform-plan.md` D4 | L6 protections（连亏/回撤停机） |

> G5 与「不做风控」的定位冲突需澄清：**定位不变**——平台仍不拦截交易；但应在 **SDK 层提供可选的风控原语/回调**（移动止损、position 加减、连亏熔断），让「模板策略作者」能低成本写出稳健策略，而非平台替用户决策。

---

## 4. 模板策略目录（Catalog）——核心交付

> 难度：★=纯策略层（不动平台）　★★=小改数据/执行　★★★=需新原语/多腿。
> **本阶段聚焦 A/B/E（方向性开仓 + 网格·均值回归 + 事件）；C 市场中性、D 做市已标【后置·本阶段不做】。**

### A. 趋势 / 动量（**本阶段主力**，学术上最稳的方向性族）
| 模板 | Edge | 适用市况(regime) | 借鉴/实证 | 难度 |
|---|---|---|---|---|
| A1 时间序列动量 TSM | 自身过去 N 期收益方向延续 | 单边/趋势 | 月/周 lookback 优于日（Baltas-Kosowski）；**单一 EMA 近似最优**（Valeyre）；**仓位=风险预算/ATR%（L1）** | ★→★★ |
| A2 趋势跟踪·加固版 | 顺势吃波段 | 高 ADX | **ATR 吊灯止损(chandelier)** + ADX 门控 + 连亏熔断（L3/L6） | ★ |
| A3 横截面动量 | 多币强弱轮动 | 板块分化 | 需多标的（L4）；buy winners、弱币做空 | ★★ |
| A4 突破 Donchian/ATR 通道 | 波动扩张跟进 | 区间突破 | 20/55 通道 + 假突破过滤；扣往返费降换手（Zakamulin） | ★ |

### B. 均值回归 / 网格·DCA（**震荡市与 A 负相关，可平滑权益曲线**；马丁 Passivbot 化）
| 模板 | 改造点 | 难度 |
|---|---|---|
| B0 均值回归 布林/RSI-2 | 偏离回归；**仅在低 ADX/震荡 regime 启用**；与 A 分散 | ★ |
| B1 智能网格（regime 门控） | 仅在**震荡/低趋势**市况启用（ADX/ATR 判定），趋势市自动停 | ★ |
| B2 DCA + 安全单层数上限 + 硬止损 | `safety order count` 封顶、触发总账户止损，杜绝无限摊薄 | ★ |
| B3 Trailing 分段止盈 + min-profit 覆盖成本 | 出场用 A-S trailing；**每层最小利润 > 双边手续费**（合约往返~0.1%） | ★ |

### C. 【后置·本阶段不做】市场中性（原「稳定主力」设想，留待独立模式重启）
| 模板 | Edge 来源 | 平台依赖 | 风险 | 难度 |
|---|---|---|---|---|
| C1 **资金费率套利（delta 中性）** | 现货多 + perp 空，收正资金费 | G1(funding 数据)+G2(双腿) | funding 翻负、执行两腿、基差 | ★★ |
| C2 基差 / Cash-and-Carry | 买现货空季度合约吃基差 | G2；收益已压缩(<5%) | 展期、保证金 | ★★ |
| C3 跨所资金费/价差套利 | 不同 venue funding 差 | G2 + 多交易所 + 预置资金 | 提币延迟/counterparty | ★★★ |
| C4 **统计套利 / 配对（协整）** | BTC-ETH 等 spread 均值回归 | G1 `informative_pairs` 式多标的 | 相关性断裂、协整失效 | ★★★ |

#### 【后置】C1 规格 · 资金费率套利（本阶段不做，仅留落地蓝图备查）
- **建仓**：`ctx.fundingRate` 近 N 期滚动均值为正且 > 阈值 → 现货买 N notional + perp 空 N notional，delta≈0。
- **收租 / 退出**：每 8h 结算收正资金费；**近 N 期 funding 均值转负** 或 basis 异常（perp 折价）→ 双腿原子平仓或缩表（**regime 门控，别硬扛**）。
- **双腿原子**（G2 `hedgeOpen/hedgeClose`）：一腿成交、另一腿失败必须**回滚**，杜绝裸敞口——这是套利最大风险点。
- **仓位 / 杠杆**：短腿 ≤3x、留强平缓冲；现货腿尽量进统一账户做保证金抵扣，压低资金占用（§1.1 的 5.1% 就是被占用吃出来的）。
- **风控**：连亏/回撤熔断（R5）+ funding 翻转告警 + 短腿强平价监控。
- **本平台硬限制**：现跑 **Binance demo 合约**——demo **无真实现货腿、funding 结算未必模拟** → C1 **只能先回测**（真实 price + funding 历史），**主网小仓验证两腿执行**后才谈上量；demo 实测对 C1 **无收益参考意义**。
- **真实风险清单**：funding 翻转（2026-02~04 实证连负三月）、basis risk、短腿强平（3x 遇 +33% 行情爆保证金）、**auto-deleveraging(ADL)**、venue/托管风险、成本吃掉资金费。

### D. 【后置·本阶段不做】做市（独立模式，需 L2/限价/低延迟）
| 模板 | 模型 | 平台依赖 | 难度 |
|---|---|---|---|
| D1 价差做市 A-S | 保留价 r=s−q·γ·σ²(T−t)、最优价差 δ；库存 q 偏置出货 | G3(L2+限价)、低延迟 | ★★★ |
| D2 库存中性网格 MM | 双边挂单 + 库存上限 + 对冲腿 | G3 | ★★★ |

### E. 波动率 / 事件（利用已有 news 服务）
| 模板 | Edge | 依赖 | 难度 |
|---|---|---|---|
| E1 波动率突破/收缩 | 低波后扩张入场 | 已有 ATR/realizedVolatility | ★ |
| E2 新闻事件驱动 | `news.service` + LLM 情绪 → 事件交易 | 已有 news/AI market 服务 | ★★ |

**优先级**：先补 **G2 波动率定标仓位 + G3 移动出场 + G4 回测台**（L1/L3/L5，才是「稳」的真正来源）→ 上架 A1/A2/A4/B0 加固版（★ 纯策略层，带 regime 门控）→ 补 G1 做 L4 跨周期/标的分散与 A3 横截面→（远期·后置）C/D。

---

## 5. 平台改造路线（方案，不含代码）

### R0 · 仓位/风险引擎（对应 G2，**本阶段第一优先**，L1 落地）
- 把「下单数量」从策略手写固定 quantity，升级为**平台按风险预算定标**：`notional = equity · riskPerTrade% / (k·ATR%)`（波动率定标），并封顶杠杆/最大 notional。
- 策略只声明**意图（方向 + 风险单位）**，仓位大小由引擎按当前波动率算——这是方向性「稳」的最大杠杆（Kim-Tse-Wald）。
- 保持「不拦截」定位：仓位引擎是**默认脚手架**，策略可 opt-out 自带数量。

### R1 · 数据服务扩展（对应 G1，服务 L2/L4）
- **本阶段重心**：每实例可声明**多周期 + 多标的**只读依赖（高周期判趋势=regime；多币做横截面/分散）。`MarketService` 已支持多 symbol，扩展为按声明喂 `ctx`。
- 借鉴 freqtrade `informative_pairs()`：`manifest.capabilities` 增 `dataDependencies: [{symbol, timeframe}]`，平台下载对齐后给 `ctx.extra`。
- 【后置】funding rate / basis / OI / 多空比（服务市场中性，本阶段不接；数据源 Binance REST 已备）。

### R2 · 执行/出场原语（对应 G3，服务 L3）
- `StrategyExecutor` 增加：**ATR 移动/吊灯止损（chandelier）**、**bracket（止盈+止损一体）**、**reduce-only**、**时间止损**；结合 R0 按风险单位下单。
- 【后置】限价 maker、现货腿、双腿原子对冲 `hedgeOpen`（服务做市/套利，本阶段不做）。

### R3 · 上下文契约扩展
- `StrategyContext` 增（本阶段）：**多周期 candles/ATR 序列**、`relatedSymbols`（横截面/分散）、**regime 判定所需原始序列**（ADX/已实现波动由策略自算，平台只给事实）。
- 【后置】`fundingRate`、`basis`、`orderBook`。
- 保持「只给事实不给建议」原则不变，新增字段同样只是原始数据，计算归策略。

### R4 · 回测与评价体系（对应 G4，**最优先补**）
- **架构：回测 = 实盘同一引擎（parity，学 NautilusTrader）**——把现 `onTick(ctx, exec)` 契约接一个「历史事件流回放器」，喂历史 K 线 / funding / 多标的，走**同一条策略代码**；事件驱动 + 成对/funding 回放，对齐现 Lot/成交对账口径。
- **防过拟合三件套（学术级，Bailey & López de Prado）**：
  - **Walk-forward + Combinatorial Purged Cross-Validation (CPCV)**：多路 train/test 组合切分；**purging**（剔除与测试标签重叠的训练样本）+ **embargo**（测试窗后再隔离一段）防前视泄漏。
  - **Deflated Sharpe Ratio (DSR)**：按「搜了多少组参数/变体」惩罚选择偏差，**DSR 不显著的策略禁止上架**（把「排行榜按 Sharpe 排」升级成「按 DSR 把关」）。
  - **参数敏感性热区**（vectorbt 式扫描）：只上架**稳健参数区**，不上架孤立最优点。
- **两道内建质检（学成熟引擎）**：① **lookahead/前视检测**（freqtrade 做法：注入随机未来扰动、若指标改变即报警）；② **point-in-time 数据卫生**（LEAN 的 survivorship-bias-free 理念：回测任一时点只能用该时点已知数据）。
- **性能**：回放器/参数扫描走量化+并行（Node Worker/WASM），不逐 tick 串行（§2.4 趋势 3）。
- **成本模型必须扣全**：双边手续费（合约往返 ~0.1%）+ 滑点 + **perp 持仓资金费** + 资金占用机会成本；输出一律到 `performance.service` 指标（Sharpe/Calmar/回撤/胜率/盈亏比）。
- **报告口径**：**费后、以已实现为权威**（沿用本会话刚修的 income 净额口径纪律，避免回测/面板/排行三口径分叉）。
- **现实约束**：方向性可在 demo 实跑（不需现货腿/真实 funding）；但回测必须扣全费用/滑点，demo 只验工程链路。

### R5 · SDK 层风控原语（对应 G5，不违背「不拦截」定位）
- 提供**可选回调**：`useCustomStopLoss`（移动/分段止损）、`adjustPosition`（动态加减仓）、`onProtection`（连亏 N 笔/回撤超阈 → 停该实例）。
- 定位为「模板策略作者的脚手架」，是否启用由策略声明，平台不替用户决策。

### R6 · 市场分类与上架标准（对应「市场运营」）
- `manifest` 扩展：`category`（方向/网格/中性/做市/事件）、`regimeFit`（趋势/震荡/高波动）、`expectedSharpe/drawdown`。
- 上架门槛：必填 capabilities + riskNotes + **至少一份回测或前向 track record**；排行榜按 **Sharpe 排序并强制展示最大回撤**（现 `strategy-platform-plan.md` §6 已定调，落地到市场页）。

---

## 6. 本阶段要做哪些 · 带来的意义 · 分阶段蓝图

### 6.1 我们要做的 6 件事 & 各自的意义（一眼看清「做什么 / 为什么值得做」）

| # | 要做什么（交付） | 带来的意义（可衡量的改变） | 杠杆/阶段 |
|---|---|---|---|
| **D1** | **波动率定标仓位引擎**：`notional=equity·risk%/ATR%`，封顶杠杆 | 方向性「稳」的**第一来源**；实证显示仓位规则能把收益质量提升数倍（Kim-Tse-Wald）——**同信号下回撤更可控、Sharpe 更高** | L1 / P1 |
| **D2** | **parity 回测台**（回放同一 onTick）+ **CPCV/DSR/lookahead 三道防过拟合** | **把「稳不稳」从口号变成可证伪的数字**；DSR 当上架闸门，**杜绝回测漂亮、实盘亏钱**；是其余一切的地基 | L5 / P0 |
| **D3** | **regime 门控 + ATR 移动/吊灯出场**（进每个模板） | 直击现两策略亏损根因（错市况硬做）：**趋势只在趋势市、回归只在震荡市**；锁盈砍亏 → **显著削尾部回撤** | L2/L3 / P1-P2 |
| **D4** | **protections 熔断**（连亏 N 笔/回撤超阈停实例） | 给「稳」一个**工程下限**：再好的策略也有连亏期，自动停机防小亏酿成大亏；契合市场「按风险排序」定位 | L6 / P2 |
| **D5** | **多周期 + 多标的只读数据**（informative 式） | 打开**分散**这道最便宜的免费午餐：跨周期/跨币低相关 → **组合 Sharpe 推向 1.5~2、权益曲线更平滑**；也是横截面动量 A3 的前提 | L4 / P3 |
| **D6** | **市场分类 + track record 展示**（category/regimeFit/DSR/回撤） | 兑现平台「**策略市场**」定位：用户**按风险/市况选策略**而非只看收益率，好模板沉淀可信实盘记录 → 市场可信度与复利 | 运营 / P4 |

**一句话意义**：D1+D2 是「能不能稳」的**分水岭**（先做）；D3+D4 把现两策略从「赌博」做成「做工」；D5+D6 让市场真正「多且可信」。**六件事全部服务方向性开仓，不触碰现货腿/双腿/盘口——零后置依赖，全部可在现有 demo 合约推进。**

### 6.2 分阶段蓝图（交付物 / 验收）

| 阶段 | 内容 | 交付物 | 验收判据 |
|---|---|---|---|
| **P0** | 回测台重建（R4，parity + CPCV + DSR） | 事件驱动回测 + walk-forward + purge + Deflated Sharpe | 跑现两策略得**费后基线**；马丁网格暴露大回撤→坐实问题；**DSR 成上架闸门** |
| **P1** | **仓位/风险引擎 + 移动出场（R0,R2 → L1/L3）** | 波动率定标下单 + ATR 吊灯/时间止损 + bracket | 同信号下**回撤显著下降、Sharpe 提升**（验证 L1 是主因） |
| **P2** | 方向性模板加固上架（A1,A2,A4,B0 → L2 regime + L6 protections） | 4 个加固模板 + regime 门控 + 连亏/回撤熔断 | 各自过 DSR；趋势与回归互补、组合权益曲线更平滑 |
| **P3** | 多周期+多标的（R1,G1 → L4） | informative 式多数据依赖 + 横截面动量 A3 | 跨周期/标的分散把**组合 Sharpe 推向 1.5~2** |
| **P4** | 市场运营（R5,R6） | 分类/regimeFit/track record 展示、按 DSR+回撤排序 | 市场页按风险筛选；沉淀前向实盘 track record |
| （后置） | 市场中性/做市（原 C/D） | funding/basis 数据、双腿对冲、L2 盘口 | 本阶段不做，见 §4 C/D 备查 |

---

## 7. 务实提醒与风险（方向性）

- **别指望方向性 Sharpe 2~5**：单一趋势/动量长期 Sharpe ~1.0~1.3、回撤 30%+ 是常态（Quantpedia TSM 实证）。目标定在**组合级 Sharpe 1.5~2、回撤<20%** 已属优秀，靠 L1~L6 组合拳而非圣杯。
- **收益质量主要由仓位决定**：Kim-Tse-Wald——去掉波动率缩放，TSM 月 alpha 1.27%→0.41%。**先建 G2 仓位引擎，再谈信号**。
- **错市况=亏损主因**：趋势策略在震荡市反复打脸、均值回归在单边市被套（现两策略通病）。**regime 门控（L2）是上架前置**，不是可选。
- **趋势有失效期**：金融危机后 4 年趋势回报减半（Hutchinson-O'Brien）；BTC 也有关闸/流动性危机同向期。配 **protections 熔断（L6）** 兜底。
- **过拟合 & 起始日敏感**：堆指标=cherry-picking（单个 EMA 已近最优，Valeyre）；同一策略晚一天上线可能由盈转亏（Maymin）。**DSR + CPCV（R4）当上架闸门**。
- **过度交易吃光边际**：日频动量弱、换手高；扣合约往返 ~0.1% 后很多「漂亮」信号归零（Zakamulin）。回测必须扣全成本。
- **本阶段不写代码**：本文为评审稿，确认方向后再按 P0→…进入 Plan/实现。

### 7.1 【后置·市场中性/做市】风险备查
- funding 翻转（2026-02~04 连负三月）、短腿强平、**ADL**（2025-10-10 $19B 清算）、**Ethena USDe depeg ~$0.65 / TVL $14.8B→$3.9B**、双腿非原子成交裸敞口、跨所搬仓延迟、demo 无现货腿/不模拟 funding。→ 待重启该模式时逐条落实。

---

## 8. 附录：借鉴清单（含 License，落地前须核对合规）

| 项目 | 地址 | License | 抄什么 |
|---|---|---|---|
| freqtrade | github.com/freqtrade/freqtrade | GPL-3.0（copyleft，**仅借鉴设计不链接代码**） | 策略分层、informative_pairs、protections 熔断、walk-forward |
| Hummingbot | github.com/companionlabs/hummingbot | Apache-2.0（较宽松） | V2 Executor/Controller/MDP 三层（编排思想）；**A-S 做市属后置** |
| Passivbot | github.com/enarjord/passivbot | AGPL-3.0（**网络 copyleft，勿直接抄源码**） | 网格/DCA 加固：safety 上限、trailing、min-profit |
| Jesse | github.com/jesse-ai/jesse | MIT | 指标/多周期 API、回测开发体验 |
| vectorbt | github.com/polakowo/vectorbt | 自定义(受限商用) | 向量化参数敏感性扫描 |
| NautilusTrader | github.com/nautechsystems/nautilus_trader | Apache-2.0（较宽松） | **回测/实盘同引擎（parity）**、确定性事件驱动回测、多场所抽象——P0 架构标杆 |
| QuantConnect LEAN | github.com/QuantConnect/Lean | Apache-2.0 | point-in-time/无幸存者偏差数据卫生理念、多场所执行架构参考 |
| Superalgos | github.com/Superalgos/Superalgos | AGPL-3.0（勿抄源码） | 可视化策略设计器 + 社交/榜单市场运营形态（最贴近我们的定位） |
| Qlib | github.com/microsoft/qlib | MIT | ML 管线/RD-Agent 因子挖掘（研究向、未来可选） |
| López de Prado《Advances in Financial ML》 | — | 书籍（非代码） | **CPCV / purging+embargo / Deflated Sharpe** 防过拟合方法论 |

> ⚠️ GPL/AGPL 项目：**只借鉴思路/公式/架构，不复制源码进本仓库**（本仓为 TS 全自研，避免传染风险）。A-S 模型是公开论文（2008），可直接自实现。

### 8.1 关键实证文献（本阶段方向性结论的出处）

- **Moskowitz, Ooi & Pedersen (2012) – Time Series Momentum**：TSM 经典定义；月度重标、**仓位反比于波动率**。（Quantpedia 收录：Sharpe 1.31、DD −33.9%）
- **Kim, Tse & Wald – Time Series Momentum and Volatility Scaling**：TSM 的 alpha 主要来自**波动率缩放**（去掉缩放后月 alpha 从 1.27% 降至 0.41%）。→ **L1 仓位定标是首要杠杆**。
- **Barroso & Santa-Clara (2015) / Daniel & Moskowitz (2016)**：**波动率管理**提升 Sharpe、削减尾部；恒定波动缩放最简高效。
- **Baltas & Kosowski**：月/周/日动量**低相关=不同延续现象**；线性回归趋势信号优于简单符号。→ **L4 多周期分散**。
- **Hurst, Ooi & Pedersen – A Century of Evidence**：趋势跟随百年来**每个十年均为正、与传统资产低相关、危机 alpha**。→ 方向性的长期依据。
- **Hutchinson & O'Brien – Trend Following and Financial Crises**：危机后 4 年趋势回报**减半**。→ **L6 熔断兜底**。
- **Valeyre (2025) – Breaking the Trend**：**单个 EMA 近似最优，堆指标=cherry-picking**；**Maymin – Momentum's Hidden Sensitivity to Starting Day**：起始日敏感。→ **L5 防过拟合**。
- **LeBeau Chandelier Exit**：ATR 吊灯移动止损。→ **L3 非对称出场**。
- **Bailey & López de Prado – Deflated Sharpe Ratio / CPCV**：回测防过拟合方法论（上架闸门）。

---

## 9. 待你拍板（方向性收敛后）

1. **稳定化优先级**：认可「**先建 G2 波动率定标仓位引擎 + G4 回测台**（L1/L5 才是「稳」的真正来源），再上模板」这条路线吗？
2. **P0 vs P1 先后**：先 **P0 回测台**（给现两策略费后基线、坐实回撤问题），还是先 **P1 仓位/移动出场**（立竿见影降回撤）？（我倾向 P0→P1，但 P1 见效更直观）
3. **首批模板**：认可 **A1 时间序列动量 + A2 趋势加固 + A4 突破 + B0 均值回归（均带 regime 门控）** 作为第一批？横截面动量 A3（需多标的）放 P3。

市场中性/做市（原 C/D）按你指示**整体后置**，文档已标【后置】、保留备查。确认后再进入逐项 Plan（决策完整的实施计划）与实现。
