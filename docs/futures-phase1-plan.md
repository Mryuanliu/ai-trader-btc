# 现货 / 合约双市场架构 · 最终技术方案

> 版本：**最终版 v-final** · 2026-08-30
> 参考：`docs/binance-api/`（币安 API 本地速查）、`docs/decision-lanes-plan.md`（决策链路）

---

## 〇、已确认的决策（用户拍板）

| # | 决策 | 内容 |
|---|---|---|
| 1 | 合约策略 | 合约可**自行选策略**，与现货保持一致的策略体系（可插拔、共用同一套策略插件） |
| 2 | 杠杆 | 默认 **5 倍** |
| 3 | 开关 | 合约链路**默认开启** |
| 4 | 链路形态 | **新建独立的合约链路**（不复用现货执行路径） |
| 5 | AI | 合约也要能结合 AI（复用决策链路设计） |
| 6 | 架构原则 | **能力上独立、架构上关联、可拓展、可插拔**；整体链路有公用部分也有差异部分 |

---

## 一、架构总览

### 1.1 现状：已有成熟的"决策内核"可复用

现有系统已经沉淀出一个可复用的决策内核（`apps/server/src/agent/`）：

```
行情 → 指标(computeIndicators) → 信号(buildSignals) → 倾向分(scoreSignals)
     → 决策链路分派(decisionLane: strategy|hybrid)
     → 策略插件(StrategyRegistry) → 决策(BUY/SELL/HOLD)
     → 出场规则(exitRules) → 风控 → 下单执行

注：原 llm 链路（AI 直出 BUY/SELL/HOLD）已于 2026-08-30 移除。
两条链路的买卖都由确定性策略执行，区别仅在于策略参数是否经 AI 元参数调节。
```

其中 `hybrid` 链路已实现"AI 输出元参数 → 纯函数映射 → 策略执行"的分层裁决（`context-mapping.ts`）。

**这意味着：合约不需要重建决策能力，只需要替换执行/风控/持仓这三块。**

### 1.2 核心命题：纵向复用决策，横向隔离市场

用户要求的"能力上独立、架构上关联"，落到设计上就是：

- **纵向（决策链）公用**：行情指标、策略插件、AI 上下文、决策链路分派 —— 现货与合约**共用同一套代码**
- **横向（市场能力）隔离**：执行、风控、持仓 —— 现货与合约**各自独立实现**，通过接口抽象可插拔

```
                    ┌──────────────────────────────────┐
                    │  决策内核（公用 · 零市场差异）      │
                    │  指标 → 信号 → 策略插件 → 决策     │
                    │  AI 上下文层（hybrid 元参数）      │
                    └───────────────┬──────────────────┘
                                    │ 决策（BUY/SELL/HOLD）
                    ┌───────────────┴──────────────────┐
                    │  市场执行器接口 MarketExecutor     │
                    │  （可插拔 abstraction）           │
                    └───────┬───────────────┬──────────┘
                            │               │
              ┌─────────────▼──┐   ┌────────▼─────────┐
              │ 现货执行器       │   │ 合约执行器         │
              │ TradingService │   │ FuturesExecutor   │
              │ 现货风控        │   │ 合约风控（杠杆/    │
              │ 现货持仓(多头)   │   │ 保证金/强平/做空）  │
              └────────────────┘   └───────────────────┘
```

### 1.3 六层架构（标注公用 / 差异）

| 层 | 职责 | 归属 |
|---|---|---|
| **L0 数据层** | K 线、行情、资金费率 | **公用**（加 `market` 维度区分数据源） |
| **L1 上下文层** | AI 元参数（regime/激进度/情绪），1h TTL | **公用** |
| **L2 信号层** | 指标计算、六信号合成 | **公用** |
| **L3 决策层** | 策略插件 + 决策链路分派 | **公用**（策略注册表共用，`strategyName` 各自独立配置） |
| **L4 执行层** | 下单、精度取整、方向语义 | **差异**（现货多头 vs 合约多空 + 杠杆 + 保证金） |
| **L5 风控层** | 额度、频率、回撤、强平 | **差异**（合约增加杠杆钳制/强平距离/保证金） |
| **L6 持仓层** | 持仓推导、盈亏 | **差异**（现货多头成本均价 vs 合约净持仓可空） |

**关键**：L0~L3 完全共用，L4~L6 各自实现。新增第三个市场（如期权）只需实现 L4~L6。

---

## 二、核心抽象：市场执行器（MarketExecutor）

这是"可插拔"的关键。定义一个统一接口，现货与合约各自实现。

### 2.1 接口设计

```ts
/** 市场执行器：现货/合约的能力边界封装（可插拔） */
export interface MarketExecutor {
  /** 市场类型标识 */
  readonly market: 'spot' | 'futures';
  /** 该市场的交易所 code（合约是 binance-futures） */
  readonly exchange: ExchangeCode;

  /** 取账户可用资金（现货=USDT 可用；合约=可用保证金） */
  getAvailable(asset?: string): Promise<number>;
  /** 取当前持仓（现货=多头数量；合约=净持仓，可为负=空头） */
  getPosition(symbol: string): Promise<PositionView>;
  /** 风控校验（各自规则不同） */
  checkRisk(input: RiskInput): Promise<DecisionRiskVerdict>;
  /** 执行下单（内部处理方向语义、杠杆、精度） */
  placeOrder(input: ExecOrderInput): Promise<ExecResult>;
  /** 取交易对精度/最小名义（合约 minNotional=100USDT） */
  getFilters(symbol: string): Promise<SymbolFilters>;
}
```

### 2.2 两个实现

| | 现货执行器 `SpotExecutor` | 合约执行器 `FuturesExecutor` |
|---|---|---|
| 包装对象 | 现有 `TradingService` + `RiskService` | 新增 `FuturesTradingService` + `FuturesRiskService` |
| `getAvailable` | 现货余额 USDT free | `/fapi/v2/balance` 的 availableBalance |
| `getPosition` | `computePosition`（多头） | `/fapi/v2/positionRisk`（净持仓，可负） |
| 方向语义 | BUY=买，SELL=卖 | BUY=开多/平空，SELL=开空/平多（配 `reduceOnly`） |
| 下单 | `/api/v3/order` | `/fapi/v1/order` + 先设杠杆/保证金模式 |
| 风控 | 现有规则 | 增加：杠杆钳制、强平距离、保证金校验 |

### 2.3 注册表（可插拔的落点）

```ts
export class MarketExecutorRegistry {
  private map = new Map<MarketType, MarketExecutor>();
  register(ex: MarketExecutor): void;
  get(market: MarketType): MarketExecutor;   // 'spot' | 'futures'
}
```

启动时注册 `SpotExecutor`、`FuturesExecutor`；未来加新市场只需 `register`。

---

## 三、公用部分 vs 差异部分（详细对照）

### 3.1 完全公用（零改动复用）

| 能力 | 现有位置 | 说明 |
|---|---|---|
| 指标计算 | `packages/shared/src/indicators/core.ts` | `computeIndicators` |
| 信号合成 | `packages/shared/src/indicators/signals.ts` | `buildSignals`/`scoreSignals` |
| 策略插件 | `packages/shared/src/strategy/` | `trend_following`/`mean_reversion`/`breakout` 三个策略**完全共用** |
| 策略注册表 | `strategy/registry.ts` | `strategyRegistry` |
| 决策链路分派 | AgentEngine `produceDecision` | `strategy`/`hybrid` 两态（原 `llm` 已移除） |
| AI 上下文层 | `strategy/context-mapping.ts` | `mapInsightToParams` 元参数映射 |
| AI 客户端 | `agent/llm.client.ts` | `analyzeContext`（仅输出元参数，不输出买卖指令） |
| 熔断/退避 | AgentEngine `recordFailure` 等 | 健壮性机制 |

### 3.2 差异实现（各自独立）

| 维度 | 现货 | 合约 |
|---|---|---|
| 交易所 code | `binance` | `binance-futures`（新增） |
| 域名 | `demo-api.binance.com` | `demo-fapi.binance.com` |
| 方向 | 只多 | 多/空（`positionSide=BOTH` + `reduceOnly`） |
| 杠杆 | 无 | 1~10 倍（**默认 5**，钳制上限 10） |
| 保证金 | 全额 | 逐仓（下单前 `setMarginType` + `setLeverage`） |
| 最小名义 | 5 USDT | **100 USDT** |
| 持仓 | `computePosition`（正） | 交易所 `positionRisk`（可负） |
| 强平 | 无 | 有（`liquidationPrice`） |
| 资金费 | 无 | 每 8h 结算（回测计入，实盘由交易所扣） |
| 风控 | 额度/频率/回撤/敞口 | 上述 + 杠杆钳制 + 强平距离预警 + 保证金校验 |

### 3.3 决策语义映射（现货 → 合约）

策略输出仍是 `BUY/SELL/HOLD`，合约侧解释为：

| 策略输出 | 现货语义 | 合约语义（无持仓） | 合约语义（持多） | 合约语义（持空） |
|---|---|---|---|---|
| BUY | 买入 | **开多** | 加多（或忽略） | 平空（`reduceOnly`） |
| SELL | 卖出 | **开空** | 平多（`reduceOnly`） | 加空（或忽略） |
| HOLD | 观望 | 观望 | 观望 | 观望 |

**已确认决策**：BUY=开多、SELL=开空（无持仓时）。反向信号先平仓再反手。

---

## 四、AI 如何结合（复用分层裁决）

合约**完全复用**现有 `hybrid` 链路设计，不另起炉灶：

```
AI 输出元参数（regime / aggression / newsSentiment / positionView）
    ↓ 纯函数映射 mapInsightToParams（公用，可回测）
策略参数（entryThreshold / confidenceFloor / positionMultiplier）
    ↓
策略插件执行（公用）
    ↓ 决策 BUY/SELL/HOLD
合约执行器（差异：杠杆/保证金/方向）
```

**合约专属的 AI 增强**（差异部分）：AI 的 `aggression`（激进度 0~1）可额外映射为**杠杆调节**：

```
leverage = clamp(round(baseLeverage × (0.6 + aggression × 0.8)), 1, maxLeverage)
例：base=5, aggression=0.5 → 5×；aggression=1 → 7×（激进加杠杆）；aggression=0 → 3×（保守降杠杆）
```

这样 AI 在合约上多了一个"仓位强度"的调节维度，同时保持"AI 不直接下达买卖指令"的原则。

**AI 失效保护**：沿用现有 TTL + 中性默认（`NEUTRAL_CONTEXT_INSIGHT`），合约不停摆。

---

## 五、数据模型

### 5.1 新增：合约 Agent 配置（独立链路）

独立配置表 `futures_agent_configs`（或扩展现有 `agent_configs` 加 futures 块），实现"独立开关、独立选策略"：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | **true** | 合约链路默认开启（用户要求） |
| `symbol` | `BTCUSDT` | |
| `timeframe` | `5m` | |
| `decisionIntervalSec` | 300 | |
| `strategyName` | `trend_following` | **可自行选策略**，与现货同一策略体系 |
| `strategyParams` | `{}` | |
| `decisionLane` | `hybrid` | 两态：`strategy`=纯策略（零 LLM）；`hybrid`=AI 上下文 + 策略执行 |
| `leverage` | **5** | 默认 5 倍，钳制 1~10 |
| `marginType` | `isolated` | 逐仓 |
| `positionPct` | 0.1 | 保证金占用比例 |
| `minConfidence` | 0.6 | |
| `exitRules` | 全关 | 止损/止盈 |
| `maxLeverage` | 10 | 硬上限 |
| `liquidationBufferPct` | 0.15 | 强平距离预警阈值（距强平价 <15% 拒加仓） |

### 5.2 K 线加 `market` 维度

`market_candles` 加 `market` 列（`'spot'|'futures'`），唯一索引改 `(symbol, market, interval, openTime)`。
迁移 `1700000004000-FuturesMarket.ts`（幂等 + down）。

### 5.3 资金费率表

新表 `funding_rates`（symbol / fundingTime / rate），唯一索引 `(symbol, fundingTime)`，供回测使用。

### 5.4 订单/成交扩展

`orders` 表加：`market`（现货/合约）、`leverage`、`positionSide`、`reduceOnly`。
（合约持仓以交易所 `positionRisk` 为权威，不落库推导。）

### 5.5 交易所 code 扩展

`EXCHANGE_CODES` 加 `binance-futures`；`.env` 加 `BINANCE_FUTURES_API_KEY/SECRET`（**已验证：可复用现有 binance key**）。

---

## 六、实施阶段（Commit 划分）

### Commit 1 · 基础设施：类型 + 市场维度 + 合约账户

- `shared/types/common.ts`：`EXCHANGE_CODES` 加 `binance-futures`；新增 `MarketType`、`FuturesPositionSnapshot`
- 迁移：`market_candles` 加 `market` 列重建索引；建 `funding_rates` 表
- 合约账户接入：`exchange-account.service` label 扩展、`accounts.controller` 校验改为 `EXCHANGE_CODES.includes()`、`exchange-registry` 新增分支、`seed.ts` 补占位、`configuration.ts` 加 env

### Commit 2 · 合约适配器（行情 + 账户）

- `binance-futures.adapter.ts`：走 `demo-fapi.binance.com`
  - 行情：`/fapi/v1/klines`、`/fapi/v1/time`、`/fapi/v1/exchangeInfo`、`/fapi/v1/fundingRate`
  - 账户：`/fapi/v2/balance`、`/fapi/v2/positionRisk`
  - 复用 `signature.ts`、`axiosTransport`、`withRetry`

### Commit 3 · 合约执行器（下单 + 杠杆 + 方向）

- `FuturesTradingService`：`setLeverage`、`setMarginType`(isolated)、`placeOrder`（含 `positionSide`/`reduceOnly`）
- `FuturesRiskService`：杠杆钳制、强平距离预警、保证金校验、minNotional(100USDT)
- `FuturesPositionService`：读交易所 `positionRisk` 为权威持仓

### Commit 4 · MarketExecutor 抽象 + 注册

- 定义 `MarketExecutor` 接口与 `MarketExecutorRegistry`
- `SpotExecutor` 包装现有现货服务（**不改现货逻辑**）
- `FuturesExecutor` 包装 Commit 3
- 验证：现货执行器行为与改造前完全一致（回归断言）

### Commit 5 · 合约决策引擎（独立链路）

- `FuturesEngine`：复用 `StrategyService`、指标、`produceDecision` 三态分派、hybrid AI 上下文
- 合约配置（独立 enabled/strategyName/leverage）
- 出场规则方向感知（空头 pnlPct 公式翻转）
- 熔断/退避复用既有机制

### Commit 6 · 合约回测（含杠杆/资金费/强平）

- `shared/position.ts` 新增 `computeFuturesPosition`（净持仓、可负、先平后反手）
- `engine.ts` 新增 `runFuturesBacktest`（独立资金模型），**现货路径零改动**
- `metrics.ts` 回合配对支持空头
- `candle-source.ts` 按 market 选择适配器（去除硬编码）
- 单测：单边涨 3x 多头 / 单边跌 5x 空头 / 横盘资金费 / 急跌强平 / 反向反手 + **现货回归断言**

### Commit 7 · CLI + HTTP + 前端

- CLI：`--market=futures --leverage=5 --compare-leverage`（1x/3x/5x 对比表）
- HTTP 回测：DTO 加 market/leverage
- 前端：回测表单加市场选择 + 杠杆；合约面板（持仓/强平价/资金费/杠杆设置）；合约配置页

### Commit 8 · 验收与文档

- 端到端验证：合约 demo 策略自动下单跑通
- 输出现货 vs 3x vs 5x 对比表与结论

---

## 七、验收标准

1. `pnpm typecheck` 三包全过、vitest 全绿（含现货回归断言）
2. 迁移 up/down 幂等；现货 K 线数据完好、现货回测结果**与改造前逐字节一致**
3. **合约 demo 策略自动下单跑通**：策略产出 BUY/SELL → 合约开多/开空 → 持仓与强平价正确回读
4. 合约风控生效：杠杆钳制（上限 10）、接近强平价拒单、minNotional 校验
5. 独立开关：关闭合约不影响现货；现货关闭不影响合约
6. 策略可插拔：合约切换 `mean_reversion`/`breakout` 无需改引擎
7. AI 结合：`hybrid` 链路在合约上生效，AI 失效时回落中性参数不停摆
8. 回测 CLI 输出 1x/3x/5x 对比表

---

## 八、风险与规避

| 风险 | 规避 |
|---|---|
| **合约默认开启 + 5 倍杠杆的风险** | 配套硬风控：杠杆上限 10、强平距离 15% 预警拒加仓、positionPct 保证金上限；demo 虚拟资金，可随时关停 |
| 合约下单误操作 | 逐仓模式（单仓风险隔离）、`reduceOnly` 防反手放大 |
| 现货行为被改坏 | 现货执行器只做包装不改逻辑 + 回归断言 |
| 强平模型过粗（回测） | 保守判定（先查强平后查止损），注释为简化模型 |
| 合约 demo 后端故障 | 已验证可用；出错先 ping `/fapi/v1/time` 区分网络/账号问题 |

---

## 九、明确不做（本阶段）

- 不做合约 UI 的独立 K 线图表（复用现有，加合约账户面板）
- 不做多档维持保证金率/ADL/清算层级精确建模
- 不改动现货策略层任何逻辑
- 不做合约手动下单面板（主线是策略自动下单）
