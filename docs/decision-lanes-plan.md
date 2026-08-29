# 双决策链路改造计划

> **目标**：让「AI（LLM）链路」与「纯策略（技术指标）链路」成为两条**完全独立、互不干扰**的决策通道，
> 通过显式开关选择走哪一条；纯策略链路同时改造为**可插拔的多策略框架**。
>
> 文档状态：待评审 · 最后更新 2026-08-29

---

## 一、现状与问题

### 1.1 当前链路：纯策略是 AI 的「降级兜底」，而非独立通道

```
                        ┌─ LLM 可用 → AI 决策 ────────────┐
调度器 → runOnce() ─────┤                                  ├→ 落库 → 风控 → 下单
                        └─ LLM 失败 → fallbackDecision() ──┘        ↑
                                      (硬编码六信号)              degradedAction=hold
                                                                   在此强制改为 HOLD
```

`fallbackDecision()` 是 `AgentEngine` 的一个**私有方法**，只在 LLM 失败时被触发，
因此它不是一个可独立选择的通道，而是一个依附于 AI 链路的降级分支。

### 1.2 由此产生的四个问题

**问题一：想跑纯策略必须先把 LLM 搞挂**

`LLM_ENABLED=false` 时的实际链路：

```
llm.available = false
  → decide() 返回 "未配置 LLM_API_KEY，已降级为纯指标策略"
  → degraded = true
  → fallbackDecision() 算出 BUY/SELL
  → degradedAction = 'hold'  ← 强制改回 HOLD
```

`degradedAction` 的默认值 `hold` 语义是「LLM 挂了不让兜底策略接管资金」，
但副作用是：**主动关掉 LLM 想跑纯策略时，也会被这道保护挡住**，永远不下单。

**问题二：开关职责混乱**

当前要跑纯指标需要同时改三个地方，且语义互相纠缠：

| 配置项 | 作用 | 问题 |
|---|---|---|
| `LLM_ENABLED` | 环境变量，控制 LLM 客户端可用性 | 全局，运行时不可调 |
| `degradedAction` | LLM 失败后的行为 | 把「降级保护」和「策略开关」混为一谈 |
| `enabled` | Agent 总开关 | 无法表达「用哪条链路」 |

**问题三：策略能力不可扩展**

策略逻辑硬编码在 `fallbackDecision()` 里。改阈值要改代码、要重启，
无法并存多个策略做对比，也无法离线回测。

**问题四：纯策略本身存在缺陷**

用真实行情实测（5m 周期、200 根 K 线）发现：

```
当前市场：score = 0.6364 → BUY，confidence = 0.70 → 会下单
```

| 缺陷 | 说明 |
|---|---|
| **死区** | 代码阈值 `|score| ≥ 0.25`，但 confidence 需 `|score| ≥ 0.375` 才到 0.6。0.25~0.375 段会产出 BUY/SELL 决策记录，然后被置信度拦掉 |
| **归一化过度自信** | 分母只统计非中性信号权重。单一信号非中性时 `score = ±1.0 → confidence = 0.85`；信号越多反而 score 越小 |
| **量能信号失效** | 分子用未闭合 K 线的成交量 ÷ 20 周期均值。未闭合 K 线量未累积完，实测 `volumeRatio ≈ 0.00`，权重 0.10 的信号长期 neutral |
| **无出场规则** | 只有 BUY/SELL/HOLD，无止损/止盈/移动止损。盈利持仓无法兑现，亏损持仓只能等「看空」信号 |

---

## 二、目标设计

### 2.1 核心：链路开关（`decisionLane`）

新增一个**顶层三态开关**，替代现有混乱的控制方式：

| 值 | 含义 | LLM 调用 | 典型延迟 | 适用场景 |
|---|---|---|---|---|
| `llm` | 只用 AI 链路 | 是 | 1~10s | 需要语义理解新闻、复杂推理 |
| `strategy` | 只用纯策略链路 | **否（零请求）** | <10ms | 确定性规则、零成本、无外部依赖 |
| `hybrid` | AI 为主、策略校验（阶段 5） | 是 | 1~10s | 用规则否决 LLM 的明显错误 |

### 2.2 「完全独立、互不干扰」的具体含义

这是本次改造的核心约束，逐条落实：

| 维度 | `llm` 链路 | `strategy` 链路 |
|---|---|---|
| 外部依赖 | LLM API（网络、密钥、配额） | **无**，纯本地计算 |
| 失败来源 | 网络/超时/配额/zod 校验失败 | 几乎不会失败（无 I/O） |
| 失败影响 | 按 `llmFailurePolicy` 处理 | 不适用 |
| **相互耦合** | **LLM 挂掉不会切到纯策略**（除非显式配置 `fallback: strategy`） | **策略链路不读取任何 LLM 状态** |
| 决策依据 | 语义推理（含新闻、多周期叙事） | 指标规则计算 |
| 可调参数 | `model` / `temperature` / `maxTokens` / `systemPrompt` | `strategyName` / `strategyParams` |
| 决策记录标识 | `lane='llm'` | `lane='strategy'` + `strategyName` |
| 成本 | token 费用 | 零 |

**关键隔离点**：`strategy` 链路下，`LlmClient` 完全不参与——
不读 `LLM_ENABLED`、不读 `LLM_API_KEY`、不发请求、不产生 token 费用。
即使 LLM 配置全部为空，纯策略也能正常工作。

### 2.3 改造后的链路

```
                                    ┌─────────────────────────────────────┐
                                    │         共享前置（两条链路共用）      │
                                    │  行情快照 → 指标计算 → 持仓/余额上下文 │
                                    └───────────────┬─────────────────────┘
                                                    │
                        ┌───────────────────────────┴───────────────────────────┐
                        │              decisionLane 分派                         │
                        └───────────────────────────┬───────────────────────────┘
                                                    │
              ┌─────────────────────┬───────────────┴────────────┐
              │                     │                            │
      decisionLane='llm'   decisionLane='strategy'      decisionLane='hybrid'
              │                     │                            │
      ┌───────▼────────┐   ┌───────▼────────────┐       ┌───────▼────────────┐
      │ LlmClient      │   │ StrategyService     │       │ LLM 决策            │
      │ .decide()      │   │ .evaluate(name)     │       │   ↓                │
      │                │   │                     │       │ 策略校验/否决       │
      │ 失败 →         │   │ 注册表:              │       │                    │
      │ llmFailure     │   │  trend_following    │       └────────┬───────────┘
      │ Policy         │   │  mean_reversion     │                │
      │  hold|strategy │   │  breakout           │                │
      └───────┬────────┘   └───────┬─────────────┘                │
              │                    │                              │
              └────────────────────┴──────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  共享下游（两条链路完全一致）  │
                    │  决策落库 → 风控 → 下单执行   │
                    └─────────────────────────────┘
```

**保持不变的部分**（降低风险）：
- 行情快照、指标计算、风控校验、下单执行、决策落库 —— 两条链路完全共用
- `TradingService` 仍是唯一权威下单出口
- 熔断、退避、降级保护等健壮性机制

### 2.4 架构理念：AI 与策略应当如何协作

「隔离还是结合」是个伪二选一。真正的问题是：**AI 该在哪一层参与决策**。
本节给出本项目的架构主张，作为后续所有设计的依据。

#### 2.4.1 先看两者的能力边界

| 维度 | 量化策略（规则） | LLM |
|---|---|---|
| 本质 | 确定性规则 | 概率性推理 |
| 优势 | 精确、可回测、可证伪、亚毫秒、零边际成本 | 处理非结构化信息、跨域联想、理解「这次不一样」 |
| 致命弱点 | 只能识别见过的模式，参数易过拟合 | 不可回测、不可复现、会幻觉、延迟大、有成本 |
| 失效模式 | 市场状态切换时连续亏损（**可预测**） | 随机性错误（**不可预测**） |

关键差异在最后一行：**策略的失败是可预测的（可回测出最大回撤），AI 的失败不可预测**。
这决定了它们该被放在架构的哪一层。

#### 2.4.2 为什么「AI 直接下达买卖指令」是高风险架构

这是当前项目的做法（`decisionLane='llm'` 时 LLM 直接输出 BUY/SELL），存在三个工程层面的硬伤：

1. **不可回测** —— 无法离线验证一次 prompt 改动的收益影响。
   这意味着**每次调 prompt 都是在真金白银上做实验**，且无法归因。
2. **不可复现** —— `temperature > 0` 时同样输入产生不同输出，出问题后无法复盘。
3. **延迟与成本** —— 1~10s 延迟 + token 费用，决策频率被锁死在分钟级以上。

#### 2.4.3 为什么纯策略也不够

- 技术指标 alpha 衰减严重（RSI/MACD/布林带几乎是公开共识，同质化极高）
- 无法处理叙事驱动行情：现货 ETF 资金流、监管政策、交易所暴雷 —— 这些**不在 K 线里**
- 近两年的 BTC 行情大量由宏观流动性与 ETF 申赎驱动，纯价格指标的解释力在下降

#### 2.4.4 推荐架构：分层裁决（Layered Adjudication）

核心原则：**AI 不做执行决策，只做上下文判断；策略不做全市场判断，只做精确执行。**

```
┌─ Layer 4  风控层    硬约束，规则实现，不可绕过，AI 不得参与
├─ Layer 3  执行层    策略规则，确定性，可回测，AI 不得参与
├─ Layer 2  信号层    指标计算，确定性，可回测
├─ Layer 1  上下文层  ← AI 唯一的参与位置
└─ Layer 0  数据层    行情 / 新闻 / 链上 / 资金流
```

**AI 应当输出「元参数」，而不是买卖指令**：

| AI 应输出（上下文层） | AI 不应输出（执行层） |
|---|---|
| 市场状态判断（趋势 / 震荡 / 高风险） | BUY / SELL / HOLD |
| 风险偏好建议（激进度 0~1） | 具体仓位比例 |
| 新闻情绪打分与事件影响评估 | 止损止盈点位 |
| 对当前持仓的定性评估 | 下单时机 |

策略层接收这些元参数作为**输入条件**，但执行逻辑本身仍然是确定性规则。

#### 2.4.5 这个架构的四个收益

1. **可回测** —— AI 的判断可冻结为历史快照充当已知条件，策略层完全确定性，可离线回放
2. **可归因** —— 亏损时能量化是「AI 判断错了市场状态」还是「策略执行有问题」
3. **降级安全** —— AI 挂掉时策略层用**中性默认参数**继续运行，而不是停摆或裸奔
4. **成本可控** —— 市场状态变化慢，AI 调用可降至 1 小时甚至 1 天一次；
   而策略执行仍可维持 5 分钟频率，两者解耦

#### 2.4.6 一个重要的实践建议：让 AI 做研究，而不是做交易

这是许多成熟量化团队的做法：

```
1. 用 AI 分析历史行情，找出「策略在什么情况下会失效」
2. 把这些发现固化成规则（例：波动率 > X 时仓位减半）
3. 回测验证这条规则是否真的改善绩效
4. 上线执行 —— 此时执行的是规则，不再依赖 AI 在线推理
```

**AI 的价值被固化成了可回测的规则**，而不是每次都依赖实时推理。
这既保留了 AI 的洞察力，又规避了它的不可回测性。

#### 2.4.7 映射到本项目的演进路径

| 阶段 | 架构形态 | AI 角色 |
|---|---|---|
| 当前 | AI 直出买卖指令 | 决策者（高风险） |
| 阶段 0~4 | 两条独立链路，可切换 | 决策者 或 完全不参与 |
| 阶段 5 | 分层裁决 | **上下文提供者**（元参数） |
| 长期 | AI 用于研究与特征工程 | 研究员（离线） |

因此 `hybrid` 模式不是「策略校验 LLM 的输出」这么简单，
它的正确形态是：**AI 提供上下文，策略基于上下文执行**。
这也是本计划把它安排在阶段 5 的原因——需要前面的可回测基础设施就位。

#### 2.4.8 AI 元参数的三种使用方式

AI 输出「市场状态 / 风险偏好 / 新闻情绪」之后，怎么作用于策略？有三种方式：

| 方式 | 机制 | 优点 | 风险 |
|---|---|---|---|
| **A 策略切换** | regime → 选择不同策略运行 | 直观、贴合直觉 | 离散突变、边界抖动、切换时持仓归属不清 |
| **B 参数调节** | 元参数 → 映射到 `positionPct` / `minConfidence` / 止损宽度 | 连续平滑、策略逻辑不变、可回测 | 需设计映射函数 |
| **C 条件过滤** | 极端情况一票否决（如情绪极端负面 → 禁止开新仓） | 最安全，AI 日常不介入 | 覆盖面有限 |

**推荐组合**：以 **B 为主**（连续调节），**A 为辅**（仅 regime 置信度高时才切换），**C 兜底**（风控层）。

**为什么 B 优先于 A**：策略切换是离散的，AI 判断在趋势/震荡边界反复横跳时，
会导致策略反复切换、反复被止损打脸。参数调节是连续的，同样的抖动只造成参数小幅波动。

#### 2.4.8.1 澄清：策略数量与参数调节是两个正交维度

容易混淆的一点，先明确区分：

| 维度 | 由谁决定 | 变化频率 | 含义 |
|---|---|---|---|
| **用哪个策略**（逻辑） | 人工静态选择，或 regime 高置信度时才切换 | 低（天/周级，甚至固定不变） | 决定策略的**逻辑结构** |
| **策略参数怎么调**（强度） | AI 元参数实时映射 | 高（分钟级，跟随 AI 输出） | 决定这个逻辑的**激进度** |

**「一个策略 + 参数调节」是推荐形态**：
选一个策略跑着（例如 `trend_following`），AI 只调它的参数，不换策略。

```
人工选定：trend_following（逻辑固定，可回测）
    ↓
AI 输出：trendStrength=0.72, aggression=0.8, newsSentiment=+0.3
    ↓
映射：positionPct = 0.1 × 0.8 = 0.08
      minConfidence = 0.6 + (1 - 0.3) × 0.1 = 0.67
    ↓
执行：还是 trend_following，但这次用 0.08 仓位、0.67 门槛出手
```

**但要注意参数调节的能力边界**：
参数只能表达**同一逻辑的强弱**，不能表达**逻辑的切换**。
趋势跟踪的参数无论怎么调，都调不出均值回归的行为——那是相反的赌注方向。

因此：

- **只做趋势跟踪** → 一个策略 + 参数调节完全够用，这是推荐的 MVP
- **想在震荡市做均值回归** → 必须引入第二个策略，因为逻辑相反，参数调不出来

**结论**：先落地「一个策略 + 参数调节」验证 AI 层是否真的有增量价值（用 2.4.10 的上下界法）；
确认有效后，再考虑为不同的市场状态引入策略家族。反过来做会一开始就背负多策略的复杂度。

#### 2.4.9 关键设计约束

1. **AI 输出连续值而非枚举**

   ```
   ✗ regime: 'trending'                    # 离散，边界抖动
   ✓ trendStrength: 0.72, regimeConfidence: 0.82   # 连续，可平滑
   ```

2. **映射规则是确定性代码，可回测**
   AI 的不可回测性被隔离在「regime 判断」这一个点上，
   从 AI 输出到策略参数的映射是纯函数，可离线回放验证。

   示例映射（`strategyParams` 由 AI 元参数驱动）：

   ```
   positionPct    = base × aggression
   minConfidence  = base + (1 - |newsSentiment|) × 0.1
   stopLossPct    = f(volatility, riskLevel)
   ```

3. **策略切换必须滞回（hysteresis）防抖**
   - 连续 N 次判断一致才切换，或设置切换冷却期
   - 避免在边界高频切换

4. **明确持仓归属**
   切换策略时，已有持仓由谁负责出场？两种做法：
   - 出场统一由独立的出场引擎接管（推荐，与策略解耦）
   - 由开仓时的策略负责（需维护持仓→策略映射）

5. **AI 输出有 TTL，过期回落到中性默认值**
   AI 调用频率（小时级）远低于策略执行频率（分钟级），
   中间时段复用上次输出；超过 TTL 则用中性默认值继续运行，**不停摆**。

#### 2.4.10 如何量化 AI 这一层到底值不值

这是判断「要不要做阶段 5」的客观依据：

| 回放场景 | 含义 |
|---|---|
| **上界**：完美预知 regime | AI 判断 100% 正确时的绩效 |
| **下界**：固定中性 regime | 完全不用 AI 时的绩效 |
| **实际**：历史 AI 输出回放 | 真实可得的绩效 |

**上界与下界的差距 = AI 环节的价值上限**。
若两者差距很小，说明 AI 这一层不值得做——直接砍掉，省掉 token 成本与延迟。

这个方法论同样适用于阶段 5 的验收：不是「AI 有没有用」，而是「AI 值多少钱」。

---

## 三、数据模型变更

### 3.1 `agent_configs` 新增列

| 列 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `decisionLane` | varchar(16) | `'llm'` | 链路开关：`llm` / `strategy` / `hybrid` |
| `llmFailurePolicy` | varchar(16) | `'hold'` | 仅 `llm` 链路生效：LLM 失败后 `hold` / `strategy` / `skip` |
| `strategyName` | varchar(32) | `'trend_following'` | 策略标识 |
| `strategyParams` | jsonb | `{}` | 策略专属参数（JSON），各策略自定义结构 |

**关于 `degradedAction`**：现有字段在 `strategy` 链路下不再有语义，
计划保留列但标记废弃（`strategy` 链路忽略它），避免破坏存量数据；
文档与前端不再暴露它，改由 `llmFailurePolicy` 承担「LLM 失败怎么办」的职责。

### 3.2 `agent_decisions` 新增列

| 列 | 类型 | 说明 |
|---|---|---|
| `lane` | varchar(16) | 本次决策走的链路，用于归因分析 |
| `strategyName` | varchar(32) | 策略链路下记录具体策略名 |

新增索引 `(lane, createdAt)`，便于按链路筛选决策历史。

### 3.3 迁移策略

新建迁移文件 `1700000002000-DecisionLanes.ts`，全部使用 `IF NOT EXISTS`，
存量行的 `lane` 回填为 `'llm'`（历史决策均来自 AI 链路）。

---

## 四、策略框架设计

### 4.1 接口定义

```ts
/** 策略输入的只读上下文 */
export interface StrategyContext {
  symbol: string;
  timeframe: Timeframe;
  /** 已计算的指标快照 */
  indicators: IndicatorSnapshot;
  /** 按时间升序的 K 线（含未闭合的最后一根） */
  candles: Candle[];
  /** 预设信号（复用现有 buildSignals，也允许策略自行计算） */
  signals: Signal[];
  /** 当前持仓，可为 null */
  position: PositionSnapshot | null;
  /** 账户可用余额 */
  account: { quoteFree: number; baseFree: number };
  /** 策略专属参数，由各策略自行校验 */
  params: Record<string, unknown>;
}

/** 策略输出 */
export interface StrategyOutput {
  action: DecisionAction;             // BUY / SELL / HOLD
  confidence: number;                 // 0~1
  reason: string;                     // 人类可读的决策依据
  riskNotes?: string;
  /** 可选：策略建议的出场条件，供后续出场引擎消费 */
  exit?: { stopLossPct?: number; takeProfitPct?: number; trailingPct?: number };
}

/** 策略契约 */
export interface Strategy {
  /** 唯一标识，对应配置中的 strategyName */
  readonly name: string;
  /** 展示名 */
  readonly label: string;
  readonly description: string;
  /** 参数 JSON Schema，用于前端动态渲染与后端校验 */
  readonly paramSchema?: Record<string, unknown>;
  readonly defaultParams: Record<string, unknown>;
  evaluate(ctx: StrategyContext): StrategyOutput;
}
```

### 4.2 首批策略

| 策略 | 标识 | 逻辑 | 状态 |
|---|---|---|---|
| **趋势跟踪** | `trend_following` | 现有六信号加权逻辑迁移，同时修复四个缺陷 | 阶段 1 |
| **均值回归** | `mean_reversion` | 布林带极值 + RSI 超买超卖 + 要求回归至中轨 | 阶段 3 |
| **通道突破** | `breakout` | ATR/布林通道突破 + 量能确认，配 ATR 止损 | 阶段 3 |

策略注册到 `StrategyRegistry`，`StrategyService` 按 `strategyName` 取用。

### 4.3 四个缺陷的修复方案

**① 死区** —— 统一阈值口径，让决策与行为一致：

```
修前：score 阈值 0.25 / confidence 阈值 0.6 → 实际生效 0.375
修后：单一阈值驱动，confidence 直接由信号强度映射，不再二次截断
```

具体做法：把 `minConfidence` 的比较对象从「映射后的 confidence」改为「原始 score」，
或在策略内部完成 score→confidence 映射时保证单调且无跳变。

**② 归一化过度自信** —— 分母改为**全部信号权重**而非仅非中性部分：

```
修前：score = Σ(方向×w_非中性) / Σ(w_非中性)     → 单信号即可 = ±1.0
修后：score = Σ(方向×w_全部)   / Σ(w_全部)       → 信号越多越可信，方向一致才高
```

这样「六个信号全部看多」才是 1.0，「只有一个弱信号看多」只能拿到该信号权重占比。

**③ 量能信号** —— 分子改用**最后一根已闭合 K 线**：

```ts
// 未闭合 K 线成交量未累积完，恒偏小
const lastClosed = candles.at(-2) ?? candles.at(-1);
volumeRatio = avgVolume20 > 0 ? lastClosed.volume / avgVolume20 : NaN;
```

**④ 出场规则** —— 新增可选出场引擎（阶段 3）：

策略可在输出中携带 `exit`（止损/止盈/移动止损），
由独立的出场检查环节在每次决策前优先评估：
**持仓亏损触及止损 → 强制 SELL，优先级高于任何开仓信号**。

---

## 五、实施阶段

分阶段推进，每阶段可独立验收、可独立回滚。

### 阶段 0：链路开关（先解耦，不改策略逻辑）✅ 已完成（2026-08-29，与阶段 1 合并实施）

**目标**：让两条链路的选择成为显式开关，消除 `degradedAction` 的耦合。

**实施说明**（与原计划的差异）：
- 阶段 0+1 合并实施（分派的中间产物是纯浪费），提交切分：数据层 → 策略框架 → 引擎分派 → 前端 → 回测
- `hybrid` 配置层暂不开放：写入归一为 `'llm'` + warn，引擎留防御分支，阶段 5 才启用
- **lane 归属口径**：llm 链路 + `llmFailurePolicy='strategy'` 降级产出的决策记
  `lane='llm'` + `degraded=true` + `strategyName=<实际策略>`；
  纯策略链路记 `lane='strategy'`。两字段组合可唯一归因
- `skip` 语义：LLM 失败时不落库、计入连续失败（走既有退避/熔断）；默认 `hold` 保持旧行为
- 存量 `degradedAction='signal'` 行由迁移一次性映射为 `llmFailurePolicy='strategy'`

**改动**：
- `packages/shared`：新增 `DecisionLane`、`LlmFailurePolicy`、`StrategyName` 类型与默认值
- `apps/server/agent/agent-config.service.ts`：新增四个配置列与钳制校验
- `apps/server/agent/agent-engine.service.ts`：重构 `runOnce()` 为分派式

```ts
private async produceDecision(ctx, config): Promise<LaneResult> {
  if (config.decisionLane === 'strategy') {
    // 完全不触碰 LlmClient
    return this.strategyService.evaluate(config.strategyName, ctx);
  }
  const llm = await this.llm.decide(...);
  if (llm.ok) return { ...llm.data, lane: 'llm' };

  // LLM 失败：按显式策略处理，而非隐式切到兜底
  switch (config.llmFailurePolicy) {
    case 'strategy': return this.strategyService.evaluate(config.strategyName, ctx);
    case 'skip':     throw new Error('LLM 不可用，已跳过本次决策');
    case 'hold':
    default:         return { action: 'HOLD', confidence: 0, lane: 'llm', degraded: true };
  }
}
```

- `apps/server/database`：新增迁移
- `apps/web`：配置页新增「决策链路」控件

**验收**：
- `decisionLane='strategy'` + 清空 `LLM_API_KEY` → 系统正常决策，日志无 LLM 相关报错
- `decisionLane='llm'` + `llmFailurePolicy='hold'` → LLM 失败时产出 HOLD，不触碰策略
- 两条链路输出的决策记录 `lane` 字段正确

### 阶段 1：策略框架 + 迁移现有逻辑 ✅ 已完成（2026-08-29）

**目标**：把 `fallbackDecision()` 抽成可插拔策略，行为保持不变。

**实施结果**：
- `packages/shared/src/strategy/`：`types.ts`（Strategy 接口含 `normalizeParams` 参数自治契约）、
  `registry.ts`（无效 name 回退 trend_following + fellBack 标记）、`trend-following.ts`（行为逐条一致，阈值/置信度参数化）
- `apps/server/src/agent/strategy.service.ts` 新增；`AgentEngine.fallbackDecision()` 已删除
- 行为一致性验证：oracle 基准（旧逻辑逐字复刻）+ 301 个真实 BTC 5m K 线滚动窗口 golden 对比，vitest 12 用例全绿
- 顺带修复：`Number(null)=0` 导致非法参数误归零的问题

**改动**：
- `packages/shared/src/strategy/`：新增 `types.ts`、`registry.ts`
- `packages/shared/src/strategy/trend-following.ts`：迁移现有六信号逻辑
- `apps/server/agent/strategy.service.ts`：新增，按 name 取策略执行
- 移除 `AgentEngine.fallbackDecision()` 私有方法

**验收**：
- 用同一份历史快照对比迁移前后的输出，**必须完全一致**（此时尚未修复缺陷）
- 单测覆盖：全中性、单一信号、多空混合、超买超卖等边界

### 阶段 2：回测引擎（已提前）✅ 已完成（2026-08-29）

**目标**：建立离线验证能力。**提前到此处的原因**：阶段 3/4 会修改策略逻辑与参数，
若无回测，这些改动只能靠 testnet 实盘试错——既慢又无法量化收益。
有了回测，后续每次策略改动都能立即看到绩效变化。

**实施结果**：
- `apps/server/src/backtest/`：`engine.ts`（纯函数回放，第 i 根收盘决策、i+1 开盘价成交，无前视）、
  `metrics.ts`（含对 buy&hold 超额）、`candle-source.ts`（区间加载 + Binance 公共 REST 自动回填）、`cli.ts`
- CLI：`pnpm -F @ai-trader/server backtest -- --interval=5m --from=... --to=...`，报告落盘 `reports/backtest/`
- 确定性验证通过：同参数连跑两次报告逐字节一致
- **阶段 3 基线**（2026-08-20 ~ 08-29，5m，2593 根）：未修缺陷的 trend_following
  总收益 -6.09% vs buy&hold +8.42%，**超额 -14.52%**，2026 笔交易（过度换手）——量化了缺陷修复的改进空间
- HTTP 端点与报告页归阶段 6

**改动**：
- 基于 `market_candles` 历史事件驱动回放
- 复用 `StrategyService`（纯函数，天然可回放）
- 复用已完成的滑点建模（`slippageBps`）与持仓推导（`computePosition`）
- 绩效报告：总收益、年化、最大回撤、夏普、胜率、盈亏比、**对 buy&hold 超额收益**
- CLI 入口：`pnpm backtest --strategy=trend_following --from=2026-01-01`

**验收**：
- 同一策略两次回放结果**完全一致**（确定性，无随机源）
- 能输出「策略 vs 持有不动」的对比，回答「跑不跑得赢躺平」

### 阶段 3：修复策略缺陷（在回测验证下进行）✅ 已完成（2026-08-29）

**目标**：修复死区、归一化、量能三个缺陷。

**实施结果**：
- 缺陷③ 量能信号：量能统计与方向判断改用已闭合 K 线（volumeRatio 不再恒偏小）
- 缺陷② 归一化：scoreSignals 分母改为全部信号权重，单信号看多不再给出满分
- 缺陷① 死区：confidence 由越过阈值幅度单调映射（起点 confidenceFloor=0.6），
  触发即通过 minConfidence，删除 confidenceBase/confidenceSpan 双重口径
- **默认 entryThreshold 0.25→0.85**（回测校准）：双窗口扫描（07-01~08-20、08-20~08-29）
  中绩效随阈值单调改善——低阈值被手续费拖垮（0.25 时 9 天 2026 笔、超额 -14.5%），
  0.85 时两窗口均转正（+1.15% / +1.67%）、回撤降至 6.3% / 2.7%
- oracle 基准删除，重写测试覆盖三个缺陷用例（shared 14 用例）

**回测对比**（08-20~08-29，5m，2593 根）：
基线（未修复）-6.09% / 回撤 12.09% / 2026 笔 → 修复后 +1.67% / 2.68% / 92 笔

### 阶段 4：出场规则 + 新增策略 ✅ 已完成（2026-08-29）

**目标**：补上止损止盈，并新增两个策略。

**实施结果**：
- **出场规则**：`exitRules` 配置（stopLossPct / takeProfitPct，相对均价小数，null 关闭，
  默认全关——出场会主动平仓，必须显式配置）。实盘引擎 `checkExitRules` 在决策流程最前、
  优先级最高，触发时产出 confidence=1 的全仓卖出决策（closeAll），两条链路均生效；
  回测引擎 `checkExitTrigger` 同口径，CLI 支持 `--stop-loss / --take-profit`
  （实测 08-20~08-29：回撤 2.68%→1.71%、收益 1.67%→1.96%）
- **新策略**：`mean_reversion`（布林极值 + RSI 双条件确认，逆向出手）、
  `breakout`（通道突破 + 放量确认）；均带 paramSchema 与参数自治
- 三策略同窗口对比（08-20~08-29）：trend_following +1.67%/回撤 2.68%、
  mean_reversion +0.52%/1.83%、breakout +2.20%/3.25%
- 前端：配置页出场规则表单（两链路可见）、决策页「出场」Tag（degradeReason 前缀识别）
- 迁移 1700000003000（agent_configs.exitRules jsonb）已在库执行

**验收**：
- [x] 单测覆盖止损/止盈触发、默认全关行为不变（server 11 用例）
- [x] 三策略同窗口回测对比输出
- strategyParams 的前端编辑表单归阶段 6（API 已支持）

### 阶段 5：AI 上下文层（分层裁决）

**目标**：实现 2.4 节的分层架构，让 AI 从「决策者」变为「上下文提供者」。

**改动**：
- AI 输出改为元参数：市场状态、激进度、新闻情绪、持仓评估
- 策略层接收元参数作为输入条件，执行逻辑仍是确定性规则
- `hybrid` 链路落地为该形态

**验收**：
- AI 不可用时策略层用中性默认参数继续运行（而非停摆）
- 回测可冻结 AI 上下文快照，验证「AI 判断 + 策略执行」的整体效果

### 阶段 6：前端与可观测

**目标**：让两条链路的差异在界面上可见、可调。

**改动**：
- 配置页：链路开关、策略选择、策略参数动态表单
- `decisionLane='strategy'` 时隐藏模型配置卡片
- 决策历史：链路标识、筛选、按链路的胜率统计
- 回测报告页：绩效曲线、回撤曲线、与基准对比

---

## 六、风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 阶段 1 迁移改变策略行为 | 纯策略产出变化 | 阶段 1 严格要求输出与迁移前**逐条一致**，用历史快照做对比测试 |
| 修复缺陷后策略变保守/激进 | 下单行为变化 | 阶段 2 输出前后对比表，且默认 `enabled=false`，需人工开启 |
| 新增配置列导致存量数据异常 | 服务启动失败 | 迁移用 `IF NOT EXISTS` + 默认值；`toShape()` 读取时钳制兜底，不抛异常 |
| 出场规则误触发清仓 | 意外平仓 | 出场规则默认关闭，需显式配置 `exit` 参数才生效 |
| `decisionLane` 与 `degradedAction` 语义重叠 | 配置歧义 | 文档中明确：`degradedAction` 废弃，仅 `llmFailurePolicy` 生效 |

**回滚方式**：每个阶段的改动都在独立提交中，可用 `git revert` 单独回退；
数据库迁移提供 `down()`，新增列可安全删除。

---

## 七、待确认事项

以下问题已按当前判断给出默认方案，需你确认或推翻：

| # | 问题 | 默认方案 | 说明 |
|---|---|---|---|
| 1 | `hybrid` 模式是否需要？ | **保留，但延后到阶段 5** | 按 2.4 节，它的正确形态是「AI 给上下文、策略执行」，而非「策略否决 LLM」。需要前面基础设施就位 |
| 2 | 回测引擎优先级？ | **已提前到阶段 2** ✅ | 你已确认加入。放在阶段 1 之后、策略改动之前，确保每次改动都能被验证 |
| 3 | `trend_following` 迁移时是否同步修缺陷？ | **否，分两阶段** | 阶段 1 保行为不变（隔离重构风险），阶段 3 在回测下修复 |
| 4 | 出场规则作用范围？ | **两条链路都生效** | 它属于持仓层能力，与决策链路正交 |
| 5 | 长期是否接受「AI 只做上下文，不下达指令」？ | **建议接受** | 这是 2.4 节的核心主张。若你希望保留 AI 直接下单能力，`decisionLane='llm'` 会一直存在，但不再是推荐路径 |

---

## 八、验收总标准

全部阶段完成后，应当满足：

**链路隔离**
- [ ] `decisionLane='strategy'` 时，即使 `LLM_API_KEY` 为空、网络不通，系统仍能正常决策下单
- [ ] `decisionLane='llm'` 时，LLM 失败不会静默切换到纯策略
- [ ] 两条链路的决策记录可通过 `lane` 字段区分与筛选

**策略框架**
- [ ] 新增一个策略只需新增一个文件 + 注册，无需改动 `AgentEngine`
- [ ] 纯策略不存在死区、过度自信、量能失效三个缺陷
- [ ] 支持止损/止盈配置，且优先级高于开仓信号

**回测与验证**
- [ ] 能用历史数据离线回测任一策略并输出绩效报告
- [ ] 同一策略两次回放结果完全一致（确定性）
- [ ] 能回答「这个策略跑不跑得赢直接持有 BTC」——相对 buy&hold 的超额收益

**分层架构（阶段 5）**
- [ ] AI 输出元参数（市场状态、激进度）而非买卖指令
- [ ] AI 不可用时，策略层用中性默认参数继续运行
- [ ] 回测可冻结 AI 上下文快照，验证整体效果

**前端**
- [ ] 可切换链路、选择策略、查看链路维度的统计
- [ ] 回测报告可视化：绩效曲线、回撤曲线、与基准对比
