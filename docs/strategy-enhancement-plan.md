# 策略诊断与增强方案

> 目标：① 回答「为什么没开单」；② 修复现有策略的数学缺陷；③ 建立可持续验证、可持续优化的策略研究闭环。
> 编写日期：2026-08-30 ｜ 状态：**待评审**（未动代码）

---

## 摘要（TL;DR）

历史决策里「置信度全是 0」不是显示问题，而是**两个叠加的真实缺陷**：

1. **HOLD 时 `confidence` 被硬编码为 0** —— 决策一旦观望就丢掉全部信息量，你无法知道「差一点就开仓」还是「差得远」。
2. **开仓阈值 `entryThreshold=0.85` 在当前 6 信号体系下数学上近乎不可达** —— 实测 `indicatorScore` 最高只到 **0.65**，从未触及 0.85。

后果极其严重：**386 条决策中 BUY 为 0 次、SELL 20 次、HOLD 361 次**。策略在长期看多的加密市场里从未做过一次多单。

治疗方案分四期，建议按序推进，每期都有独立验收标准：

| 期 | 目标 | 核心动作 | 解决什么 |
|---|---|---|---|
| **A** | 可观测 | 阻塞原因码 + 接近度 + 信号归因 | 知道「为什么没开单」 |
| **B** | 修缺陷 | 阈值重校准 + 打分口径 + 多空对称 | 让策略能正常开单 |
| **C** | 验信号 | IC 分析 + 权重反推 + 防过拟合 | 知道「哪些信号真的有用」 |
| **D** | 强能力 | 状态自适应 + 元标注 + 加密因子 | 提升期望收益 |

**优先级建议：A → B 必须先做。** 在 A、B 完成前做 C、D 是无效功——你连基线行为都无法解释，任何"优化"都是盲调。

---

# 第一部分：根因诊断

## 1.1 数据事实

取自本机 `agent_decisions` 表（截至 2026-08-30）：

| action | 条数 | confidence min | max | avg |
|---|---|---|---|---|
| HOLD | **361** | 0 | 0.55 | **0.002** |
| SELL | 20 | 0.64 | 0.88 | 0.820 |
| **BUY** | **0** | — | — | — |

最近若干条决策的 `indicatorScore`（已落库在 `inputSnapshot`）：

```
-0.350  0.650  -0.550  -0.550  -0.550  -0.350  -0.350 ...
```

**`indicatorScore` 绝对值最高 0.65，而 `entryThreshold = 0.85`。从未触及。**

## 1.2 根因一：HOLD 时置信度硬编码为 0

`packages/shared/src/strategy/trend-following.ts`：

```61:65:packages/shared/src/strategy/trend-following.ts
    let confidence = 0;
    if (action !== 'HOLD') {
      const t = (Math.abs(score) - entryThreshold) / Math.max(1e-9, 1 - entryThreshold);
      confidence = Number((confidenceFloor + (1 - confidenceFloor) * Math.min(1, Math.max(0, t))).toFixed(2));
    }
```

`packages/shared/src/strategy/mean-reversion.ts`：

```112:118:packages/shared/src/strategy/mean-reversion.ts
  private hold(note: string): StrategyOutput {
    return {
      action: 'HOLD',
      confidence: 0,
      reason: `按 mean_reversion 指标信号执行：${note}。`,
      riskNotes: '纯指标决策，未经过语义层面的新闻解读。',
    };
  }
```

只要观望，`confidence` 恒为 0，且 `reason` 是**自由文本**，无法聚合、无法统计、无法下钻。这就是「无法获取有效信息」的直接原因。

## 1.3 根因二：阈值 0.85 在 6 信号体系下近乎不可达（核心）

信号权重（`indicators/signals.ts`）合计恰为 **1.0**：

| 信号 | 权重 | 何时为 neutral（不投票） |
|---|---|---|
| ma_trend | 0.25 | 永不（非多即空） |
| rsi | 0.20 | RSI ∈ [45, 55] |
| macd | 0.20 | hist == 0 |
| bollinger | 0.15 | **%b ∈ (0.1, 0.9) —— 约 80% 的时间** |
| volume | 0.10 | 量能比 ≤ 1.2（缩量，常态） |
| mid_term | 0.10 | SMA60 为 NaN |

打分口径（`scoreSignals`）：

```177:186:packages/shared/src/indicators/signals.ts
export function scoreSignals(signals: Signal[]): number {
  let total = 0;
  let totalWeight = 0;
  for (const s of signals) {
    if (s.bias === 'neutral') continue;
    total += (s.bias === 'bullish' ? 1 : -1) * s.weight;
  }
  totalWeight = signals.reduce((acc, s) => acc + s.weight, 0);
  return totalWeight === 0 ? 0 : Number((total / totalWeight).toFixed(4));
}
```

**分子只累加非中性信号，分母却是全部权重。** 于是：

| 情形 | score | ≥0.85？ |
|---|---|---|
| 6 信号全 bullish | 1.00 | ✅ |
| bollinger neutral，其余 5 个全 bull | 0.85 | ⚠️ 恰好卡边界 |
| volume neutral，其余全 bull | 0.90 | ✅ |
| **rsi neutral（RSI 在 45~55），其余全 bull** | **0.80** | ❌ |
| **bollinger + volume 皆 neutral，其余全 bull** | **0.75** | ❌ |
| macd 反向，其余全 bull | 0.60 | ❌ |

结论：**触发开仓需要除 bollinger 外其余 5 个信号（合计 0.85 权重）全部同向、无一反对、无一弃权。** 而 bollinger 在约 80% 时间里是 neutral，volume 缩量时也是 neutral。

这不是「保守」，这是**结构性失灵**。

> 附带说明：这段逻辑的注释写着「缺陷②修复：分母使用全部信号权重……信号越多越可信」。初衷正确（防止单信号满分），但**与 0.85 阈值耦合后产生了副作用**——中性信号既不计入分子、又占据分母，等于给 score 施加了隐性惩罚。两者单独看都合理，组合起来就锁死了开仓。

## 1.4 根因三：RSI 逻辑与趋势策略内在冲突，导致多空不对称

`signals.ts` 中 RSI 的判定：

```66:80:packages/shared/src/indicators/signals.ts
  if (!Number.isNaN(rsiValue)) {
    if (rsiValue >= 70) {
      rsiBias = 'bearish';
      rsiNote = `RSI ${rsiValue.toFixed(1)} 进入超买区，警惕回落`;
    } else if (rsiValue <= 30) {
      rsiBias = 'bullish';
      rsiNote = `RSI ${rsiValue.toFixed(1)} 进入超卖区，存在反弹空间`;
    } else if (rsiValue > 55) {
      rsiBias = 'bullish';
      rsiNote = `RSI ${rsiValue.toFixed(1)} 偏强`;
    } else if (rsiValue < 45) {
      rsiBias = 'bearish';
      rsiNote = `RSI ${rsiValue.toFixed(1)} 偏弱`;
    }
  }
```

这是**均值回归**口径（超买看空）。但 `trend_following` 是顺势策略：**上涨趋势中 RSI 长期 >70，RSI 会持续投 bearish 反对票，把 score 拉低 0.4。结果是趋势最强、最该做多的时候，策略反而开不了多单。**

数据佐证：**BUY 出现 0 次，SELL 出现 20 次。** 做空只需 ma_trend / mid_term / macd 同向看空即可凑够分数，而做多会被 RSI 与 bollinger 拖累。策略被结构性偏置成「偏空」，在长期向上的加密市场里这是致命的。

## 1.5 根因四：缺少「为什么没发生」的结构化归因

当前 HOLD 只有一句自由文本。当策略不开单时，无法区分是：

- 数据不足（K 线缺失 / 指标 NaN）？
- 调度未触发？
- 信号未达阈值（差多少？哪个信号拖后腿？）？
- 达到阈值但置信度被 minConfidence 拦截？
- 有信号但被风控拒绝（minNotional / 强平距离 / 保证金）？
- 被交易所拒单？

这六类问题的排查路径完全不同。混在自由文本里，只能靠翻日志 + 作者经验猜。

---

# 第二部分：调研综述

## 2.1 「为什么没开单」的成熟解法：Blocking Reasons（阻塞原因码）

参考 EasyQuant 的可解释性设计。核心思想：**把「没发生」做成产品能力**，为每次阻塞给出可枚举的 `eventCode`，而非自由文本。设计目标四条——结构化、可聚合、可定位、可复用（同一套码同时服务回测 / paper / 生产）。

其分层体系：

| 层级 | 原因码 | 含义 |
|---|---|---|
| 标的层 | `NO_SYMBOLS` | 无可交易标的 |
| 数据层 | `NO_BARS` / `DATA_QUALITY_BLOCKED` | K 线缺失、时间戳异常、数据不新鲜 |
| 调度层 | `DUP_EVAL_SKIPPED` | 同一根 bar 重复触发被去重 |
| 配置层 | `VERSION_NOT_ACTIVE` | 改了草稿但执行侧仍用旧版本 |
| 信号层 | `SIGNAL_NONE` | 规则未触发（**不是错误**，只是行情不满足） |
| 引擎层 | `ENGINE_ERROR` | 指标/DSL 运行时异常 |
| 风控/通道 | `RISK_REJECTED` / `BROKER_REJECTED` | 有信号但被风控或交易所拒绝 |

关键洞见值得直接引用：

> 可解释性不是「讲得通」，是「查得快」。
> 衡量标准是：当策略没信号、没下单时，你能否在最短时间内定位问题类别、找到证据、形成团队共识。

排障顺序：**先看 Top 原因（24h 聚合），再看单条明细。** 某个原因码长期霸榜 Top1，说明是系统性问题而非个案。

这套体系与本项目「可回测、可归因、可审计」的原则完全同构，值得直接移植。

## 2.2 信号有效性验证：ml4t-diagnostic 的四层诊断框架

GitHub `ml4t/diagnostic`（MIT，源自 *Machine Learning for Trading* 生态，基于 López de Prado 的方法体系）。提供：

| 层 | 内容 |
|---|---|
| Tier 1 特征分析 | 平稳性、ACF、分布、特征重要性（MDI/PFI/MDA/SHAP） |
| **Tier 2 信号分析** | **IC 分析（含 HAC 稳健标准误）、分位收益、换手率、多信号对比** |
| Tier 3 回测分析 | 交易分析、**DSR、RAS、PBO**、Trade-SHAP、TP/SL 优化 |
| Tier 4 组合分析 | Sharpe / Sortino / Calmar / VaR / CVaR 等 16 项 |

统计方法与用途：

| 方法 | 解决什么 |
|---|---|
| **IC（信息系数）** | 信号值与未来收益的相关性 —— 直接回答「这个信号有没有预测力」 |
| HAC-adjusted IC | 自相关稳健的标准误，避免把噪声当显著 |
| **DSR（Deflated Sharpe）** | 校正多重检验偏差 —— 你试了 200 组参数，最好的那组 Sharpe 有多少是运气 |
| **PBO（过拟合概率）** | 回测过拟合的可能性 |
| CPCV | 无泄漏的时间序列交叉验证（purged + embargo） |

**其中 IC 分析对本项目的价值最大**：现有信号权重（`0.25/0.2/0.2/0.15/0.1/0.1`）是拍脑袋定的，从未经统计检验。IC 可以用数据反推权重，甚至直接砍掉无效信号。

## 2.3 主流开源项目横向对比

| 项目 | Stars 量级 | 定位 | 对本项目可借鉴点 |
|---|---|---|---|
| **Freqtrade** | ~9k（加密最流行） | 加密机器人，回测+实盘+Telegram | 加密场景的完备工程实践；`hyperopt` 参数寻优思路 |
| **Backtrader** | ~20k | 经典事件驱动回测 | 灵活的指标/策略组合范式；但性能一般 |
| **vectorbt** | — | 向量化、Numba/Rust 加速 | **矩阵化回测，数千组参数秒级完成** —— 参数敏感性分析的基础设施 |
| **NautilusTrader** | — | 高性能事件驱动，回测/实盘同代码 | 分层架构（策略/风控执行/数据接口）与本项目 L0~L6 分层理念一致 |
| **Qlib**（微软） | — | AI 量化研究平台 | 因子研究流水线、`RD-Agent` 自动化研究思路 |
| **ml4t-diagnostic** | 28 | 信号诊断与统计验证 | 见 2.2，**本项目最需要的部分** |
| **mlfinpy / Lopez de Prado 复现** | — | 三重障碍标注、元标注 | 见 2.5 |
| **Lean（QuantConnect）** | — | 工程化交易系统 | 多资产、多市场的工程化参考 |

> 选型判断：本项目**不需要引入任何新框架**。回测引擎已具备确定性、合约支持、杠杆对比，缺的不是回测能力，而是**信号诊断与验证能力**。建议只借鉴方法论（IC、DSR/PBO、CPCV、Blocking Reasons），在现有 TypeScript 栈内实现，避免 Python/TS 双栈带来的维护成本与数据同步问题。

## 2.4 市场状态自适应（Regime Detection）

核心思想：**不同策略在不同环境表现迥异，用一个固定阈值跑遍所有行情，必然在大部分时间失效。**

主流做法：

- **波动率分状态**：用 ATR /  realized volatility 聚类（低波/中波/高波），高波时抬门槛、缩仓位。
- **HMM / GMM 隐状态模型**：把市场划分为 bull / bear / neutral 或趋势 / 震荡，状态内用不同策略与参数。
- **趋势强度指标**：ADX、Hurst 指数、效率系数（ER）区分趋势市与震荡市——趋势市用趋势策略，震荡市用均值回归。

**这与本项目的 hybrid 链路天然契合**：AI 已经在输出 `regime`（trending / ranging / volatile）。目前 `mapInsightToParams` 只用它做了很小的门槛微调（volatile 时 +0.1，ranging 时 +0.05）。**这个能力被严重低估了**，正确用法是让它决定「用哪个策略 + 用哪套阈值」，而不只是微调。

## 2.5 元标注（Meta-Labeling）—— 提升精度的二阶模型

源自 López de Prado《Advances in Financial Machine Learning》。两阶段范式：

1. **主模型**（primary）：产生方向性信号（本项目当前的策略层就扮演这个角色）。
2. **二级模型**（secondary / meta）：不预测方向，只预测「主模型这次信号是否会成功」，输出 0/1 决定是否执行。

标注用**三重障碍法**（triple barrier）：同时设置止盈（上轨）、止损（下轨）、时间到期（竖轨），看价格先触及哪个，从而给出有金融意义的标签。

价值：

- 主模型可以保持高召回（多给信号），由二级模型负责精度（过滤掉低胜率信号）。
- **直接解决「过度交易」与「低胜率」问题**——这正是本项目最容易踩的坑（历史数据显示 0.25 低阈值时 9 天 2026 笔、超额 -14.7%）。
- 二阶段解耦后，两者可以独立优化与归因。

## 2.6 加密特有因子（本项目的差异化优势）

通用技术指标（MA/RSI/MACD/BOLL）早已被充分套利，alpha 稀薄。加密永续合约有几类**只有链上/交易所衍生品市场才有的**因子，而本项目**合约链路已经能拿到其中的 funding rate**：

| 因子 | 数据源 | 逻辑 |
|---|---|---|
| **资金费率（funding rate）** | `/fapi/v1/fundingRate`（已接入，见 `backfillFunding`） | 极端正费率 = 多头拥挤，往往预示回调；负费率 = 空头拥挤 |
| **未平仓量（OI）** | `/fapi/v1/openInterest` | OI 激增 + 价格上涨 = 趋势健康；OI 激增 + 价格滞涨 = 见顶风险 |
| **多空持仓比** | `/futures/data/globalLongShortAccountRatio` | 散户情绪反向指标 |
| **主动买卖量比（taker buy/sell）** | `/futures/data/takerlongshortRatio` | 主动买盘占比，衡量真实推力 |
| **强平级联** | 需 WebSocket 或第三方 | 强平密集区常形成短期反转点 |
| **订单簿失衡（orderbook imbalance）** | `bookTicker`（已在接入） | 盘口买卖压力不平衡，短周期有预测力 |

**建议优先级：funding rate > OI > 多空比 > taker 比。** 前两个接口稳定、历史数据充裕、逻辑清晰，且 funding rate 的基础设施（实体表 + 回填 + 回测注入）**已经建好**。

---

# 第三部分：增强方案

## 期 A｜可观测性：让「为什么没开单」可查（最高优先级）

### A1. 阻塞原因码（Blocking Reasons）

在 `packages/shared` 新增 `decision-diagnostics.ts`，定义可枚举原因码：

```ts
export type BlockingReasonCode =
  // 数据层
  | 'NO_CANDLES'              // K 线为空或不足 warmup
  | 'INDICATOR_NAN'           // 关键指标为 NaN
  | 'STALE_DATA'              // 数据不新鲜（末根 bar 时间戳过旧）
  // 信号层
  | 'SIGNAL_NONE'             // 规则未触发（行情不满足，非错误）
  | 'SIGNAL_CONFLICT'         // 信号严重分歧（多空票接近）
  // 决策层
  | 'BELOW_MIN_CONFIDENCE'    // 达阈值但置信度不足
  | 'STRATEGY_FALLBACK'       // 策略名不存在，已回退
  // 风控层
  | 'RISK_MIN_NOTIONAL'       // 名义价值不足
  | 'RISK_MARGIN'             // 保证金不足
  | 'RISK_LIQUIDATION_DIST'   // 强平距离不足
  | 'RISK_LEVERAGE_CLAMPED'   // 杠杆被钳制
  | 'RISK_INTERVAL'           // 下单间隔未到
  | 'RISK_DRAWDOWN'           // 回撤熔断
  // 执行层
  | 'BROKER_REJECTED'         // 交易所拒单
  | 'ENGINE_ERROR';           // 运行时异常
```

策略输出扩展为携带诊断：

```ts
export interface StrategyOutput {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
  riskNotes?: string;
  /** 新增：观望/拒单时的结构化归因 */
  diagnostics?: {
    code: BlockingReasonCode;
    /** 距离触发还差多少（0~1），例如阈值 0.85、当前 0.65 → gap 0.20 */
    gapToTrigger?: number;
    /** 各信号对 score 的贡献，便于定位「谁拖后腿」 */
    contributions?: { name: string; bias: SignalBias; weight: number; signed: number }[];
    /** 触发所需的最小一致权重（用于 gap 计算） */
    requiredScore?: number;
    detail?: string;
  };
}
```

### A2. 修复 confidence 语义：HOLD 输出「接近度」而非 0

保留 `confidence` 原有的「开仓信号强度」语义（避免破坏 `minConfidence` 拦截逻辑），**新增** `proximity` 字段表达接近度：

```ts
// trend_following.evaluate
const proximity = Number(Math.min(1, Math.abs(score) / entryThreshold).toFixed(3));
```

`proximity = 0.76` 即表示「已达到触发所需的 76%，还差 24%」。这让每一条 HOLD 都有信息量。

> 为什么不直接改 `confidence`：它参与 `minConfidence` 拦截与回测引擎的仓位口径，改动面大且有回归风险。新增字段是零风险增量，且语义更清晰。

### A3. 信号贡献度归因

改造 `scoreSignals`，除返回总分外返回每个信号的有符号贡献：

```ts
export function scoreSignalsDetailed(signals: Signal[]): {
  score: number;
  contributions: { name: string; bias: SignalBias; weight: number; signed: number; }[];
  /** 若要触发，还需要的同向权重 */
  gapToThreshold: (threshold: number) => number;
}
```

前端可直接渲染成条形图：绿色（多头贡献）/ 红色（空头贡献）/ 灰色（弃权），一眼看出是哪个信号否决了开仓。

### A4. 决策诊断面板

- 后端：`GET /api/agent/diagnostics?window=24h` 返回原因码聚合 Top 统计（基于 `agent_decisions` 新列 `blockingReason`）。
- 前端：Agent 页新增「诊断」Tab —— Top 原因排行 + 单条决策下钻（信号贡献条形图 + gap）。
- DB：`agent_decisions` 加 `blockingReason varchar(32)`、`proximity numeric`、`diagnostics jsonb` 三列（幂等迁移）。

**验收标准 A**：任意一条历史 HOLD 决策，都能在面板上直接看到「原因码 + 距离触发还差多少 + 哪个信号拖后腿」，无需翻日志。

---

## 期 B｜修复结构性失灵（紧随 A 之后）

### B1. 阈值重校准

`entryThreshold=0.85` 必须下调。但**不能拍脑袋定新值**——已有教训（0.25 时 9 天 2026 笔、超额 -14.7%）。

方法：

1. 用现有 5m K 线（17331 根，2026-07-01~08-30）跑**阈值敏感性扫描**：0.20 ~ 0.85 步长 0.05，输出总收益 / 夏普 / 最大回撤 / 交易次数 / 胜率。
2. 找**绩效平台的平坦区间**（plateau），取区间中点而非峰值——峰值几乎必然是过拟合。
3. 用**两个时间窗**交叉验证（07-01~08-01 与 08-01~08-30），只有在两窗都稳定才采纳。

### B2. 修复打分口径

当前「分子排除 neutral、分母包含 neutral」的口径，与高阈值耦合后锁死开仓。两种修法：

**方案 1（推荐，改动小）**：分母改用**非中性信号权重之和**，使 `score` 表达「已表态信号中的一致度」，语义更直观；同时**引入 `agreement` 字段**表达「有多少比例的信号参与了表态」，由策略同时要求 `|score| >= threshold && agreement >= 0.6`。

```ts
// score：已表态信号中的净倾向（-1~1）
// agreement：参与表态的权重占比（0~1）
// 触发条件：|score| >= entryThreshold && agreement >= minAgreement
```

这样既保留「信号越多越可信」的初衷（由 `agreement` 承担），又不会因中性信号惩罚 score。

**方案 2**：维持现口径，但把阈值降到与实测分布匹配（如 0.55~0.65）。改动最小，但语义仍别扭，后续调参容易被误导。

**建议取方案 1**，并把 `entryThreshold` 与 `minAgreement` 一起纳入 B1 的联合扫描。

### B3. 修复多空不对称与 RSI 冲突

- **`trend_following` 中 RSI 不应投反对票。** 趋势策略里，RSI > 70 代表动能强劲，应是**确认**而非**警告**。改为：趋势策略使用独立的 RSI 口径（`rsi > 50 → bullish`，超买仅作为 `riskNotes` 提示而不改变方向票）。
  - 实现方式：在 `strategyName` 维度参数化 RSI 语义，或在 `buildSignals` 中让 `trend_following` 走专用分支。
- **强制多空对称回归测试**：新增单测，构造镜像行情（把 K 线价格序列做 `2*base - price` 翻转），断言 BUY/SELL 触发次数对称。这是防止此类偏置复发的**结构性保障**。

**验收标准 B**：镜像对称性测试通过；在 2 个月历史数据上，BUY 与 SELL 触发次数不再出现 0 : N 的极端失衡；阈值敏感性扫描产出平坦区间与选定值。

---

## 期 C｜信号有效性验证与权重反推

### C1. IC 分析（借鉴 ml4t-diagnostic Tier 2）

对每个信号、每个周期（1/3/5/10 根 bar 后收益）计算：

- **IC**：信号有符号值与未来收益的 Spearman 秩相关。
- **IC t-stat（HAC 稳健）**：判断显著性，避免把噪声当信号。
- **分位收益**：按信号强度分 5 档，看 Q5 − Q1 价差是否单调。

输出一张表，直接告诉你**哪些信号值得保留、权重该多少**：

| 信号 | IC(5bar) | t-stat(HAC) | Q5−Q1 | 建议权重 | 处置 |
|---|---|---|---|---|---|
| ma_trend | ? | ? | ? | ? | 保留/降权/剔除 |

### C2. 权重反推

用 IC 加权（或 IC / IC 标准差，即 IR 加权）替代当前的手工权重，并**跑对照回测**验证：IC 权重 vs 手工权重，在样本外窗口谁更稳。

### C3. 防过拟合三件套

- **Walk-forward**：滚动训练 / 测试切分（如训练 3 周、测试 1 周，逐格前推）。
- **CPCV（组合 purged 交叉验证）**：多路径切分 + 净化（purge）+ 禁运（embargo），避免前后样本泄漏。本项目回测是逐 bar 事件驱动，需确保指标窗口不跨越切分点。
- **DSR / PBO**：任何参数寻优后，必须报告 Deflated Sharpe 与过拟合概率。**试过 N 组参数，就要为这 N 次试验买单。**

**验收标准 C**：产出《信号有效性报告》，每个信号有 IC / t-stat / 分位收益三项指标；新权重在样本外窗口不劣于原权重；参数选定过程附有 DSR/PBO。

---

## 期 D｜策略增强

### D1. 市场状态自适应（Regime-Adaptive）

把现有 AI 输出的 `regime` 从「微调门槛」升级为「策略选择器」：

| regime | 主策略 | 阈值 | 仓位乘数 |
|---|---|---|---|
| trending（趋势） | trend_following | 低门槛、顺势 | 放大（1.0~1.5） |
| ranging（震荡） | mean_reversion | 中门槛、反向 | 缩减（0.5~0.8） |
| volatile（高波） | 观望或极小仓 | 高门槛 | 大幅缩减（≤0.5） |

**关键约束（不可违背）**：AI 仍然**只输出市场状态判断**，不输出买卖指令。策略选择器是纯函数映射，与现有 `mapInsightToParams` 同构。这守住项目既定原则。

同时加入**纯量化的 regime 判据**作为 AI 的交叉验证与降级兜底（ADX / 效率系数 ER / realized vol 分位数），避免 AI 不可用时就失去自适应能力。

### D2. 元标注过滤器（Meta-Labeling）

- **三重障碍标注**：止盈 / 止损用 ATR 倍数动态设定（`±k × ATR14`），时间 barrier 设为 N 根 bar。
- **二级模型**：输入为主信号强度 + 市场状态 + 波动率等约 10 个特征，输出「本次信号是否会成功」。初期用**逻辑回归或浅梯度提升树**（可解释、抗过拟合），产出概率作为 `metaScore`。
- **执行规则**：`主信号触发 && metaScore >= 0.6` 才下单。

> **诚实提示**：本项目的标注样本极其有限（见第四部分）。元标注属于 D 期后置项，**必须在 C 期建立防过拟合基线后才可尝试**，否则极易自欺。

### D3. 加密特有因子

按优先级推进，每个因子走同一流程：接入 → 落库 → IC 检验（C 期流水线）→ 通过才入策略。

1. **资金费率因子**（基础设施已就绪：`FundingRateEntity` + `backfillFunding` + 回测注入）
   - 极端正费率（如 > 0.01%）→ 回调风险信号
   - 费率由正转负 / 由负转正 → 拥挤方向反转
2. **未平仓量（OI）**：价格涨 + OI 涨 = 趋势确认；价格涨 + OI 跌 = 动能衰竭
3. **多空持仓比 / taker 主动买卖比**：散户情绪反向指标

**验收标准 D**：每个新因子单独回测，IC 显著（t-stat > 2）且样本外有效，才允许进入合成信号。

---

# 第四部分：约束与风险（务必先读）

## 4.1 样本量是硬约束

| 数据 | 现状 | 评价 |
|---|---|---|
| 现货 5m K 线 | 17,331 根（07-01~08-30，约 2 个月） | 勉强够单策略参数校准 |
| 现货 1m K 线 | 86,416 根 | 短周期研究可用 |
| 现货 15m / 1h / 4h | 405 / 327 / 247 根 | **过少，不可用于统计检验** |
| 合约 15m K 线 | 1,345 根（08-01~08-15） | **仅半个月，样本严重不足** |
| 历史决策 | 386 条（08-29~08-30，仅 2 天） | 只能做现象观察，不能做统计推断 |

**直接推论：**

1. **D 期的机器学习类方法（元标注、复杂模型）当前不具备条件。** 2 个月数据在 5m 频率下，独立样本（非重叠）数量远少于表面根数，训练出的模型几乎必然过拟合。
2. **合约链路的因子研究需要更长历史。** 建议先用 `backfill` 把合约 K 线回填到至少 6 个月，再谈合约策略优化。
3. **B1 的阈值扫描只能用 5m / 1m**，15m 及以上频率的数据量不足以支撑结论。

## 4.2 「保证盈利」的诚实回答

**没有任何方案能保证盈利。** 行业共识与本项目的既有原则一致：能做的是提升**期望收益与风险调整后收益的可验证性**，而不是消除风险。

本方案的价值主要在于：

- 把**当前确定的亏损性缺陷**（阈值锁死、多空偏置、RSI 冲突）修掉——这些是已知的、可验证的错误；
- 建立**可归因、可复现、防过拟合**的研究闭环，让后续每一次优化都可审计；
- 把 alpha 来源从「已被充分套利的通用技术指标」拓展到「加密衍生品特有因子」，这是有真实经济学逻辑的增量。

## 4.3 实施风险与缓解

| 风险 | 缓解 |
|---|---|
| 阈值下调后过度交易，手续费吞噬收益 | B1 必须做敏感性扫描找**平坦区间**，并在两窗交叉验证；上线后先用 `dry_run` 观察 |
| 改 `scoreSignals` 破坏现有回测基线 | 新增 `scoreSignalsDetailed`，保留原函数；先并行运行对比，确认后切换 |
| IC 权重过拟合于 2 个月样本 | C3 强制 walk-forward + DSR/PBO；IC 不显著（t-stat < 2）的信号直接剔除而非降权 |
| AI regime 判断不可靠导致策略误切 | 保留纯量化 regime 判据做交叉验证；AI 失败时回落中性参数（现有 `NEUTRAL_CONTEXT_INSIGHT` 机制已具备） |
| 诊断字段膨胀拖慢决策与存储 | `diagnostics` 用 jsonb 存储；贡献度只在决策落库时计算，不进热路径 |

---

# 第五部分：建议路线

| 阶段 | 内容 | 预估 | 前置 |
|---|---|---|---|
| **A** | 阻塞原因码 + proximity + 信号归因 + 诊断面板 | 小 | 无 |
| **B** | 阈值扫描重校准 + 打分口径修复 + 多空对称测试 | 中 | A（需要 A3 的贡献度数据支撑分析） |
| **C** | IC 分析 + 权重反推 + walk-forward/DSR/PBO | 中 | B（需要稳定基线） |
| **D1** | Regime 自适应策略选择器 | 中 | B |
| **D3** | 加密因子（funding → OI → 情绪比） | 中 | C（需要 IC 流水线做准入） |
| **D2** | 元标注过滤器 | 大 | C + 数据回填至 6 个月以上 |

**建议先做 A，再看数据决定 B 的具体改法。** A 期完成后，你手上会有「每一条 HOLD 为什么 HOLD」的完整数据，那时 B 的阈值与口径怎么改，将由数据说话，而不是推测。

---

## 附：待办清单

- [ ] A1 定义 `BlockingReasonCode` 与 `diagnostics` 结构
- [ ] A2 策略输出 `proximity` 字段
- [ ] A3 `scoreSignalsDetailed` 贡献度归因
- [ ] A4 迁移 + 诊断 API + 前端面板
- [ ] B1 阈值敏感性扫描（找平坦区间）
- [ ] B2 打分口径改造（score + agreement 双条件）
- [ ] B3 RSI 语义参数化 + 镜像对称回归测试
- [ ] C1 IC / HAC t-stat / 分位收益
- [ ] C2 IC 权重反推与样本外对照
- [ ] C3 walk-forward + CPCV + DSR/PBO
- [ ] D1 regime → 策略选择器（AI 仍不直出买卖）
- [ ] D3 funding rate → OI → 多空比因子
- [ ] D2 元标注（需先补全数据）

## 参考资料

- EasyQuant《可解释性：为什么没信号、为什么没下单（Blocking Reasons 体系）》— https://www.goeasyquant.com/blog/03.html
- ml4t-diagnostic（信号诊断与统计验证，MIT）— https://github.com/ml4t/diagnostic
- López de Prado, *Advances in Financial Machine Learning*（三重障碍标注、元标注、CPCV、DSR/PBO）
- Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014)；*The Probability of Backtest Overfitting* (2016)
- 项目内已有文档：`docs/decision-lanes-plan.md`、`docs/futures-phase1-plan.md`
