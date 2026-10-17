# X（Twitter）比特币量化策略开源生态调研

> 调研日期：2026-10-17 ｜ 数据来源：X 站内搜索（opencli Browser Bridge，登录态 Chrome）+ GitHub API 交叉核实
> 用途：为平台策略路线、指标/信号族扩充与 skill 建设提供外部情报基线。所有 star / 活跃度数据以 GitHub API 当日返回为准。

---

## 1. 调研方法与样本

- **检索工具**：`opencli twitter search`，共 12 组查询，覆盖中英文、策略类型与项目名定向：
  - 中文：`比特币 量化 开源`、`比特币 量化 策略 github`、`量化 交易 策略 开源`（均带 `lang:zh` + `min_faves` 门槛）
  - 英文：`bitcoin trading strategy open source github`、`crypto quantitative trading framework github`、`trading bot open source github`、`AI trading agent open source`、`backtesting library open source`、`funding rate arbitrage strategy`、`grid trading strategy github`、`freqtrade github`、`hummingbot`
  - 排序：多数结果按加权互动量（likes×1 + RT×3 + replies×2 + bookmarks×5）二次重排取 Top。
- **交叉核实**：推文中提及的每个仓库逐一走 GitHub API 验证 star、最近 push、描述；对 t.co 短链通过推文卡片元数据还原真实仓库名。
- **样本偏差声明**：X 搜索按互动量呈营销帖偏置，本次样本约 100+ 条去重推文；结论中对"业绩承诺类"信息一律降级处理（见 §4）。

## 2. 核心结论（TL;DR）

1. **生态共识栈非常稳定**：执行层 freqtrade / hummingbot / CCXT，引擎层 NautilusTrader / QuantConnect Lean，研究层 Qlib / TradingAgents，教学层 MST。全部核实为高活跃（最近两周内均有 push）。这批项目构成"币圈量化基础设施"的事实标准，与本项目此前"外部框架仅作设计参考"的定位无冲突。
2. **"回测=实盘同一份代码"（parity）是当下讨论度最高的引擎叙事**：NautilusTrader（30.2k★）在 X 被反复安利的核心卖点就是"回测代码零改动上实盘、研究与生产同一套时间模型"——这与本项目自建 SimBroker 复用 `onTick(ctx, exec)` 契约的架构决策完全同向，可视为该路线正确性的外部佐证。
3. **Pine 生态正在被 LuxAlgo 系统性开源**：PineTS（Pine Script v5/v6 运行时，可跑在 Node/Bun/Deno/浏览器，870★，pushed=2026-10-17）+ Vela 图表引擎（WebGL2、70+ 指标、Apache 2.0）+ 指标百科 + 交易统计引擎。这直接改变"Pine 脚本 → TS 移植"的成本结构，是本轮调研对本项目最有信息量的发现（与上一轮 pinescript-strategies 调研强相关）。
4. **LLM 多 Agent 交易是流量最大赛道，但都停在"研究/决策编排"层**：TradingAgents（111k★）、ai-hedge-fund（64k★）、Vibe-Trading（35.7k★）、QuantDinger（12.8k★）。热度极高，没有一个是可验证的实盘业绩项目。对本项目的价值在"Agent Skills 化工具编排"结构参考，而非交易逻辑本身。
5. **"N 千套策略合集"类爆款帖基本是重新打包 + 付费导流**：热帖宣称的 "5,806 quant strategies"（The-Quant-Trading-Vault，348★，2026-09-27 建仓）经核实 91%（约 5,286 个）是公开 Pine Script 再分发，README 主目的是导流自家付费 harness AgenKit。**X 上的 star 增速和业绩承诺需整体打对折。**
6. **中性策略（资金费率/基差套利、做市）在 X 讨论显著升温**：Nunchi-trade/agent-cli（Hyperliquid 14 套策略：基差套利、费率收割、做市、网格，521★）、Binance 官方套利机器人推文（♥1,244 级别传播）。按平台当前"只做方向性开仓策略，市场中性与做市整体后置"的既定决策，这些**只入观察清单，不进本季路线**。
7. **数据栈经验贴质量高且与本项目现状互证**（@sera00111 系列）：分钟/小时级策略研究可完全免费起步（Binance Vision 历史 K 线 + CCXT + CoinGlass 费率/持仓/爆仓 + Dune/DefiLlama/CryptoQuant 链上）；只有订单簿/逐笔高频才需要 Tardis.dev 级专业数据。本项目 L1 数据栈（Vision 归档 + userTrades 真实费率）已站在此共识上，无需升级采购。
8. **Polymarket 5-min BTC Up/Down 延迟套利是散户最热玩法**（多条 ♥300–1,100 帖）：逻辑是币安现货价格发现领先 Polymarket 订单簿重定价若干秒，买"即将正确的边"到期收 $1.00。与本项目的 BTC 合约主线偏离，仅作为微观结构趋势素材记录。

## 3. 开源项目图谱（GitHub API 核实，2026-10-17）

### 3.1 执行框架 / 交易引擎

| 仓库 | ★ | 最近 push | 定位 | 与本项目的关系 |
|---|---|---|---|---|
| freqtrade/freqtrade | 55,475 | 10-16 | Python 加密机器人最全家桶：策略/回测/hyperopt 扫参/FreqAI 滚动重训/dry-run 模拟盘/WebUI+TG | hyperopt 与 FreqAI"定期再训练"机制是 CLI 调优迭代的对照参考；dry-run 三态与模拟室同构 |
| nautechsystems/nautilus_trader | 30,208 | 10-17 | Rust 内核 + Python 策略层，主打回测/实盘同一套代码，纳秒级事件驱动，IOC/FOK/冰山/OCO/OTO 高级订单 | parity 叙事的业界标杆；高级订单类型覆盖清单可作我方撮合器演进参照 |
| microsoft/qlib | 49,418 | 10-14 | AI 量化研究平台：因子挖掘→模型→信号 | 股票为主，Crypto 仅示例；研究范式参考 |
| QuantConnect/Lean | 22,042 | 10-16 | 事件驱动引擎（Python/C#），多资产，滑点/冲击成本建模 | 成本模型细节可对照我方 event-driven 引擎 |
| vnpy/vnpy | 45,906 | 10-06 | 中文量化框架老大哥：数据接入/gateway/事件引擎/策略四层 | 事件总线分层设计与本项目 runner/executor 分层同构 |
| ccxt/ccxt | 44,406 | 10-16 | 100+ 交易所统一 API（行情/订单簿/下单/费率） | 已是我方依赖底座之一（经 exchanges 适配层） |
| hummingbot/hummingbot | 20,491 | 10-15 | 做市/跨所套利引擎，宣称年撮合 $34B+ | 做市后置，仅观察；其 MCP 被 Clawnch 重写的案例见 §5.4 |
| StockSharp/StockSharp | 10,913 | 10-16 | C# 全链路（连接层/设计器/回测/终端） | 跨市场桌面路线，与技术栈不符 |
| jesse-ai/jesse | 8,651 | 10-16 | Python 回测+实盘，主打研究体验 | 回测研究 UX 可参考 |

### 3.2 LLM / Agent 交易框架

| 仓库 | ★ | 最近 push | 定位 | 判断 |
|---|---|---|---|---|
| TauricResearch/TradingAgents | 111,544 | 10-16 | 多 Agent 辩论式投研（分析师/研究员/风控/交易员分工） | 热度第一；决策编排层，无可验证业绩。结构可借鉴，链路不可直接下单 |
| virattt/ai-hedge-fund | 64,040 | 10-02 | 模拟 Buffett/Munger 等风格 Agent 委员会 | 官方自认 educational，非实盘 |
| HKUDS/Vibe-Trading | 35,656 | 10-16 | 港大数据智能实验室"迷你对冲基金"：90 个 Finance Skills、462 个现成 Alpha（Qlib158/Alpha101/GTJA191）、10+ 回测引擎、30 个 Swarm 团队、Shadow Account 反推交易模式 | **Skill 化架构值得重点研究**：把研究工具封装为 Agent 可调用 Skills 的做法，与我方 pine-port/调优 skill 方向一致；462 因子库可作指标/信号族扩充素材 |
| OpenByteInc/QuantDinger | 12,844 | 10-16 | "AI 量化操作系统"：自然语言生成策略→回测→执行全闭环，多市场覆盖 | 宣传口径宽泛，需读码后再评 |
| shiyu-coder/Kronos | 40,847 | 2026-04-13（⚠️） | K 线基础模型（OHLCV token 化，AAAI 2026，45+ 交易所训练） | star 极高但 6 个月无 push、282 open issues——典型"star≠维护"，先观察 |
| wherecall1 系 autoresearch-crypto | 170 | 07-04 | Karpathy autoresearch 范式：喂 11 种策略原型给进化引擎（ATLAS 并行进化 + GEPA 反思），评分非裸夏普 | 体量小但思路干净（策略原型竞争 + 成本建模），演化式参数搜索可关注 |
| Shelpid/SETS | 265 | 09-22 | 自进化网格机器人：8 基因编码 × 96 策略/代，回测淘汰 97%，每 5 秒一代 | 遗传算法扫参与我方 CLI sweep 同域，其"评分含淘汰率"设计可参考 |

### 3.3 策略合集 / 信号素材

| 仓库 | ★ | 最近 push | 定位 | 判断 |
|---|---|---|---|---|
| Alorse/pinescript-strategies | 251 | 2026-08-25 | 48 Pine v4/v5 策略 + 19 指标 + PineTS 回测管线（上轮已深挖） | 策略本体无移植价值（自带回测 Sharpe 普遍 ≤0.175 或为负）；**指标公式库有价值**（Supertrend/TTM Squeeze/Range Filter/QQE/Williams Vix Fix） |
| je-suis-tm/quant-trading | 11,036 | 2026-06-20 | 经典策略 Python 实现合集：London Breakout、Dual Thrust、Pair Trading、Heikin-Ashi、期权 Straddle、Monte Carlo | 质量实在的教学库；**London Breakout / Dual Thrust 可列入新信号族候选**（突破系，与我方 donchian 同域可对比） |
| stefan-jansen/machine-learning-for-trading | 21,378 | 10-16 | 《ML for Trading》第 3 版全书代码：walk-forward、DSR、多重检验、CSCV、61 个 Agent Skills | 与本项目闸门方法论（CPCV/DSR/PBO，López de Prado 范式）同源，可作方法论校准书单 |
| brainbrick-trades/The-Quant-Trading-Vault | 348 | 建仓 09-27 | "5,806 套量化策略"（X 爆款帖 ♥579） | ⚠️ 核实：91% 为公开 Pine Script 再打包，README 主体是付费 harness AgenKit 导流。不建议作为 alpha 来源 |
| Nunchi-trade/agent-cli | 521 | 07-08 | Hyperliquid 自动交易 14 策略（基差套利/费率收割/做市/网格），可作 CLI/Claude Code Skill/MCP | 中性策略后置决策下仅入观察清单；其"策略即 Skill/MCP 插件"分发形态有参考意义 |
| Rockyzsu/stock | 8,915 | 2026-04-17 | 中文 30 天量化：A 股数据层/可转债/形态识别/自动下单 | A 股向，与本项目无关，记录以全貌 |
| wepoets1107 冰火岛系列 | — | — | 12 个期权工具 + 量化脚本（Deribit IV 曲面扫描、动态 Delta 对冲、BTC 期权看板） | 期权层素材，平台当前不做期权，仅存档 |

### 3.4 Pine 运行时 / 数据工具（与本项目直接相关）

| 仓库 | ★ | 最近 push | 定位 | 判断 |
|---|---|---|---|---|
| LuxAlgo/PineTS | 870 | 10-17 | Pine Script v5/v6 原生运行时（Node/Bun/Deno/浏览器），60+ TA 函数、流式、回测 | 见 §5.1：作公式对照 oracle，不作依赖 |
| LuxAlgo（Vela 等，同波开源） | — | — | Vela：WebGL2 图表引擎，70+ 指标、画线、多图表工作区、插件 SDK，Apache 2.0 可商用 | 前端图表长期备选项（当前 Ant Design 栈无急迫替换需求） |
| duneanalytics/skills | 57 | 09-14 | Dune 官方 Agent Skills：链上数据查询/数据集管理 | 官方"第一方 Skill 化"趋势样本；链上数据当前非本项目输入 |
| tvscreener（推文称 ~1.6K★，未逐一核） | — | — | TradingView 选股器的 Python 库，13,000+ 字段，支持 MCP | 若需 TradingView 筛选信号做研究侧对照可试 |
| CoinGlass / Binance Vision / Tardis.dev | — | — | 费率/OI/爆仓聚合；免费历史 K 线与逐笔归档；专业订单簿数据 | 前两者我方已在用；Tardis 级别数据仅在启动订单簿研究时才需要 |

## 4. 信息源可信度分级（重要）

| 级别 | 账号/特征 | 用法 |
|---|---|---|
| A（经验型，有细节、承认风险） | @sera00111（数据栈与中性策略风险两条长推）、@_zheergen（逐仓库拆解，常附真实能力清单）、@litangsongyx（vnpy 架构拆解）、@GoSailGlobal（best-of-algorithmic-trading 榜单） | 结论可直接引用，逐条核实 |
| B（清单型，信息真但夸张） | @heynavtoor、@vorty279、@alphacartell、@KKaWSB 等 "repos that replace $X/mo" 帖 | 项目名可用作线索，性能/收益类比忽略 |
| C（hype/导流，不可作证据） | @RohOnChain、@Bober_smart、@TeddyinMedia、@RoundtableSpace 等 "most DANGEROUS / f*king insane / BlackRock leaked" 体 | 只用于识别叙事趋势；其转发的仓库逐个回源核查（本次因此识破 Quant-Vault 打包营销） |
| D（业绩承诺，无法验证） | "300 美元滚到 14000"、"$794,000 in 14 months"、"跑一晚上 +$280" 类 | 一律不采信。幸存者偏差 + 无审计，典型卖方软文结构 |

补充方法论教训：**star 增速/绝对值都不等于质量**（Kronos 40k★ 已 6 个月停滞 vs PineTS 870★ 但日更）——与本项目"star≠维护"的既有判断一致，本次再添实证。

## 5. 对 AI-trader-btc 的行动启示

按优先级排序，均为"参考/候选"，不构成既定路线图承诺。

### 5.1 PineTS 作 Pine→TS 移植的公式对照 oracle（低成本、高确定性）
上轮 pinescript-strategies 移植讨论的最大风险是 Pine 语义细节（`na` 传播、`ta.*` 递推初始化、barstate 时序）在手写 TS 复现时走样。PineTS 本身就是这套语义的可运行参考实现。做法：**不移植其运行时、不进 package.json 依赖**，仅在指标移植验收阶段（devDependency 或一次性脚本）用 PineTS 跑原 .pine 指标输出序列，与我方 `packages/shared/src/indicators` 的实现逐 bar 对拍，容差内才算移植完成。这条正好补进 pine-strategy-port skill 的"验收"环节。

### 5.2 pine-strategy-port skill 的素材与流程定稿依据
- 素材优先级维持上轮结论：Supertrend、TTM Squeeze、Range Filter、QQE、Williams Vix Fix、Heikin-Ashi/Aroon/StochRSI（补我方趋势与波动收缩两个空白维度）；
- 流程新增两步：第 0 步"来源可信度分级"（按 §4 标准先鉴别脚本作者的营销属性），第 6 步"PineTS 对拍验收"（§5.1）；
- 交叉印证源：仓库自带 BACKTEST.md 与 X 讨论热度只作筛选参考，最终裁决仍走我方 CLI（single/sweep/research/event-driven）+ DSR 闸门。

### 5.3 parity 路线的外部确认与撮合清单参照
NautilusTrader 的卖点清单（高级订单类型 IOC/FOK/冰山/OCO/OTO、纳秒级事件时间、研究=生产同代码）可当作我方 SimBroker/event-driven 引擎的**差距核对表**：当前 STOP/MARKET 两类为主，OCO/冰山类需求等策略侧出现组合订单需求时再立项。无需改变"不引入外部引擎"的既有决策——本次调研反而未见任何 TS 原生可替代方案。

### 5.4 Agent Skills 化趋势与本项目 skill 路线
Vibe-Trading（90 Finance Skills）、Dune 官方 skills、Nunchi（策略即 Claude Code Skill/MCP）、Clawnch（为 Agent 重写 Hummingbot 集成，指出官方 MCP 仅覆盖 API 的 1/4）共同指向：**研究/交易工具正在被封装为 Agent 可调用 Skills**。本项目已具备同类资产（CLI 扫参、历史数据拉取、闸门校验），把高频操作逐个 skill 化是低成本高复用的方向；pine-strategy-port 是第一个候选。

### 5.5 观察清单（本轮不动手）
- 资金费率/基差数据策略化（X 升温最快；受"市场中性后置"决策压制，解锁前不动；届时需先补 P1 历史 funding/markPrice 数据）
- London Breakout / Dual Thrust（je-suis-tm 合集内两个突破系经典，与我方 donchian 同域，可作为新信号族候选进入研究队列）
- Kronos / FreqAI 类"模型自适应重训"（等其维护状态恢复再评）
- Polymarket 5-min 延迟套利生态（微观结构素材，非本平台标的范围）

## 6. 主要原始来源

| 内容 | 链接 |
|---|---|
| sera00111 数据栈与开源入门五条 | https://x.com/i/status/2108332340753969191 ｜ 中性策略风险续篇 https://x.com/i/status/2109673806189178923 |
| LuxAlgo 开源波（PineTS/Vela） | https://x.com/i/status/2099518866799898755 |
| NautilusTrader parity 讨论（中文两条） | https://x.com/i/status/2090628703600672983 ｜ https://x.com/i/status/2110766147209413005 |
| Vibe-Trading（HKUDS）介绍 | https://x.com/i/status/2106624535449530834 |
| Hyperliquid 14 策略开源（Nunchi-trade/agent-cli） | https://x.com/i/status/2032772661722624497 |
| pinescript-strategies 在 X 的传播帖 | https://x.com/i/status/2110609259268657513 |
| 5,806 策略 Vault 热帖（已证伪为打包营销） | https://x.com/i/status/2104252995563389432 |
| best-of-algorithmic-trading 榜单帖 | https://x.com/i/status/2055809919903998093 |
| SETS 自进化网格 | https://x.com/i/status/2102513279612432504 |
| autoresearch-crypto（Karpathy 范式） | https://x.com/i/status/2052709653709254941 |
| Polymarket 延迟套利 bot 合集 | https://x.com/i/status/2052003002857431211 |
| 原始检索数据（12 组 query 的完整 yaml） | /tmp/x-research/*.yaml（本机留存，摘要 digest.md） |

> 复核说明：GitHub star/push 数据为 2026-10-17 快照，引用时注意时效；`t.co` 短链均已通过推文卡片元数据还原为真实仓库。

---

**文档定位**：外部情报基线，非实施方案。若据此起 skill（见 §5.2），另行出方案并评审。
