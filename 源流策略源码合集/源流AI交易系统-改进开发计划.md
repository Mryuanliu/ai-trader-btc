# 源流AI交易系统 V4.0 改进开发计划

> **文档版本**: v1.0
> **创建日期**: 2026-07-03
> **目标版本**: V4.0（多Agent协作架构）
> **当前版本**: V3.2（单AI入场决策）
> **文档性质**: 纲领性技术文档，指导后续迭代

---

## 目录

- [一、项目现状评估](#一项目现状评估)
- [二、问题诊断与差距分析](#二问题诊断与差距分析)
- [三、改进目标与设计原则](#三改进目标与设计原则)
- [四、多Agent协作架构设计](#四多agent协作架构设计)
- [五、分阶段开发路线图](#五分阶段开发路线图)
- [六、技术实现要点](#六技术实现要点)
- [七、黄金交易领域知识注入](#七黄金交易领域知识注入)
- [八、风险与对策](#八风险与对策)
- [九、验收标准与KPI](#九验收标准与kpi)
- [十、附录](#十附录)

---

## 一、项目现状评估

### 1.1 系统概况

| 维度 | 当前状态 | 评估 |
|------|---------|------|
| 代码规模 | 5089 行 MQL5 | 中大型项目 |
| AI集成 | DeepSeek API（单点调用） | 基础完整 |
| AI参与度 | 仅入场决策（约30%逻辑） | **严重不足** |
| 交易品种 | XAUUSD 专用 | 专注度高 |
| 主交易周期 | M15 波段 | 合理 |
| 数据采集 | M1~W1 多时间框架 | 完善 |
| 风控机制 | 每日盈亏+连续亏损+凯利 | 较完善 |
| 持仓管理 | 硬编码追踪止损 | **最薄弱环节** |
| 自学习能力 | 无 | **缺失** |
| 外部数据源 | 无 | **缺失** |

### 1.2 当前AI决策范围分析

```
┌─────────────────────────────────────────────────────────────┐
│                  当前交易流程 AI 参与度                       │
├─────────────────────────────────────────────────────────────┤
│  市场数据采集    ████████████████████░░░░  100% 硬编码       │
│  上下文构建      ████████████████████░░░░  100% 硬编码       │
│  趋势/形态识别   ██████████░░░░░░░░░░░░░░   50% AI参与       │
│  入场决策        ████████████████████░░░░  100% AI ✅        │
│  止损止盈设置    ██████████████░░░░░░░░░░   70% AI参与       │
│  仓位大小        ░░░░░░░░░░░░░░░░░░░░░░░░    0% 凯利公式     │
│  入场时机过滤    ░░░░░░░░░░░░░░░░░░░░░░░░    0% 狙击手RSI   │
│  持仓追踪止损    ░░░░░░░░░░░░░░░░░░░░░░░░    0% 硬编码       │
│  保本逻辑        ░░░░░░░░░░░░░░░░░░░░░░░░    0% 硬编码       │
│  部分平仓        ░░░░░░░░░░░░░░░░░░░░░░░░    0% 不支持       │
│  加仓决策        ░░░░░░░░░░░░░░░░░░░░░░░░    0% 不支持       │
│  平仓决策        ████░░░░░░░░░░░░░░░░░░░░   20% 仅高置信反向 │
│  风控参数调整    ░░░░░░░░░░░░░░░░░░░░░░░░    0% 静态         │
│  复盘学习        ░░░░░░░░░░░░░░░░░░░░░░░░    0% 不支持       │
└─────────────────────────────────────────────────────────────┘

综合 AI 参与度: ≈ 25%
```

### 1.3 核心优势

1. **数据采集完善**：多时间框架K线 + 成交量 + 指标历史，为AI提供了丰富上下文
2. **风控基础设施齐全**：每日盈亏限制、连续亏损冷却、凯利公式、市场状态检测
3. **API集成稳健**：JSON转义、UTF-8处理、失败重试、模拟回退
4. **统计系统完整**：从历史加载交易记录，计算Profit Factor/胜率/回撤
5. **UI仪表板专业**：实时显示AI信号、置信度、风控状态

---

## 二、问题诊断与差距分析

### 2.1 架构层面问题

#### 问题 P1：单点AI决策（最严重）
- **现状**: 只有一个AI调用入口 `CallOpenAI()`，每3分钟调用一次
- **后果**: AI无法实时响应持仓变化、市场突发事件
- **影响**: 持仓管理完全依赖硬编码规则，失去AI的智能优势

#### 问题 P2：上下文冗余
- **现状**: 每次调用发送 M1:30 + M5:50 + M15:30 + H1:30 + H4:20 + D1:30 根K线
- **后果**: Token消耗巨大（估算每次8K-15K tokens），响应慢，成本高
- **影响**: 3分钟一次的更新频率已是极限，无法做到秒级响应

#### 问题 P3：无状态记忆
- **现状**: 每次AI调用都是独立的，AI不知道自己之前做了什么决策
- **后果**: AI无法基于"我刚才开的仓现在表现如何"做决策
- **影响**: 持仓管理无法交给AI

#### 问题 P4：无失败降级策略
- **现状**: API失败时回退到简单的RSI模拟
- **后果**: 网络抖动期间交易质量骤降
- **影响**: 实盘可靠性不足

### 2.2 交易逻辑问题

#### 问题 T1：持仓管理粗糙
```mql5
// 当前退出逻辑（ManageAIPositions）：
// 1. AI高置信度(0.80+)反向 + 浮盈0.30%+ → 平仓
// 2. 利润达0.80%+ → 平仓
// 3. AI极高置信度(0.90+)反向 + 亏损 → 紧急平仓
// 4. 其他情况 → 交给追踪止损
```
**问题**: 缺乏分级止盈、移动止损优化、加仓、减仓等高级操作

#### 问题 T2：止损止盈静态
- AI给出的止损止盈点数被硬性限制（100-800点止损，100-1500点止盈）
- 没有根据市场波动率（ATR）动态调整
- 没有根据持仓时间递进调整

#### 问题 T3：无外部数据
- 黄金与美元指数(DXY)强负相关（相关系数 -0.7~-0.9）
- 美债实际收益率是黄金的"机会成本"
- 当前完全忽略这些关键因子

#### 问题 T4：无事件驱动
- 非农、CPI、Fed决议等事件前后波动剧烈
- 当前时间过滤器只避开亚盘死区，不识别重大事件

### 2.3 风控问题

#### 问题 R1：参数静态
- `InpMaxDailyLoss = 10.0` 写死
- `InpCooldownAfterLoss = 300` 写死
- 应根据账户规模、近期波动率、市场状态动态调整

#### 问题 R2：无相关性风控
- 多个同向持仓时，实际风险是叠加的
- 当前 `InpMaxPositions = 5` 允许5个多单，等于5倍单边敞口

---

## 三、改进目标与设计原则

### 3.1 总体目标

> **让 AI 从"入场顾问"升级为"全权交易决策者"**

```
当前: AI 25% 参与 + 硬编码 75%
目标: AI 85% 参与 + 硬编码 15%（仅保留底层安全网）
```

### 3.2 设计原则

#### 原则1：多Agent分工协作
- 单一AI大脑 → 多个专业Agent协作
- 每个Agent专注一个领域，prompt更精准，质量更高

#### 原则2：分层决策架构
```
战略层（低频）→ 战术层（中频）→ 执行层（高频）
   ↓               ↓               ↓
 首席分析师     入场策略师       持仓管理者
 (15分钟)       (3-5分钟)        (秒级/tick)
```

#### 原则3：安全网始终在线
- AI决策必须经过硬编码安全检查
- 风控底线不可被AI突破
- AI异常时自动降级到规则系统

#### 原则4：记忆与学习
- 短期记忆：当前持仓状态、近期决策
- 长期记忆：历史交易复盘、参数优化建议
- 自反思：定期分析自身表现

#### 原则5：Token效率优先
- 不同Agent接收不同精度的上下文
- 高频Agent用精简上下文
- 低频Agent用完整上下文

#### 原则6：黄金交易专业性
- 注入黄金特有的市场结构知识
- 集成DXY、美债等关联数据
- 识别经济日历事件

---

## 四、多Agent协作架构设计

### 4.1 系统架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                     源流AI交易系统 V4.0 架构                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  消息总线 (Message Bus)                      │   │
│  │   共享状态: 持仓/账户/市场/决策历史/Agent通信                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↑↓                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ 首席     │  │ 入场     │  │ 持仓     │  │ 风险     │          │
│  │ 分析师   │  │ 策略师   │  │ 管理者   │  │ 控制官   │          │
│  │ Analyst  │  │ Entry    │  │ Position │  │ Risk     │          │
│  │ Agent    │  │ Agent    │  │ Manager  │  │ Officer  │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │              │                 │
│       ↓              ↓              ↓              ↓                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ 复盘     │  │ 事件     │  │ 执行     │  │ 数据     │          │
│  │ 学习员   │  │ 监控员   │  │ 网关     │  │ 采集器   │          │
│  │ Reviewer │  │ Event    │  │ Executor │  │ Data     │          │
│  │ Agent    │  │ Monitor  │  │ Gateway  │  │ Feeder   │          │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  安全网 (Hard Safety Net)                    │   │
│  │   不可突破的底线: 最大回撤/爆仓防护/异常熔断                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 各Agent职责定义

#### Agent 1: 首席分析师 (Chief Analyst Agent)

| 属性 | 值 |
|------|-----|
| **角色** | 战略层决策者，判断大方向 |
| **调用频率** | 每15分钟（M15收盘） |
| **输入** | D1/H4/H1完整K线 + DXY + 美债 + 经济日历 |
| **输出** | 市场状态报告 + 偏好方向 + 关键价位 + 风险等级 |
| **Token预算** | 约 4K-6K |
| **核心Prompt** | "你是黄金市场首席分析师，专注大周期趋势判断" |

**输出格式:**
```json
{
  "regime": "TRENDING_UP|RANGING|TRENDING_DOWN|VOLATILE",
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "confidence": 0.0-1.0,
  "key_levels": {
    "support": [price1, price2],
    "resistance": [price1, price2]
  },
  "risk_level": "LOW|MEDIUM|HIGH",
  "narrative": "50字以内市场叙事",
  "recommendation": "顺势做多/区间操作/观望等"
}
```

#### Agent 2: 入场策略师 (Entry Strategist Agent)

| 属性 | 值 |
|------|-----|
| **角色** | 战术层决策者，寻找精准入场点 |
| **调用频率** | 每3-5分钟（或M5收盘） |
| **输入** | 首席分析师报告 + M15/M5/M1 K线 + 指标 + 持仓状态 |
| **输出** | 入场信号 + 止损止盈 + 仓位建议 + 入场理由 |
| **Token预算** | 约 3K-5K |
| **核心Prompt** | "你是黄金日内交易策略师，基于首席分析师的方向偏好寻找精准入场" |

**输出格式:**
```json
{
  "signal": "BUY|SELL|WAIT",
  "confidence": 0.0-1.0,
  "entry_type": "BREAKOUT|PULLBACK|REVERSAL|MOMENTUM",
  "stop_loss_points": int,
  "take_profit_points": int,
  "position_size_factor": 0.5-2.0,
  "rationale": "30字入场逻辑",
  "confluence": ["双底", "RSI超卖", "支撑反弹"]
}
```

#### Agent 3: 持仓管理者 (Position Manager Agent) ⭐核心新增

| 属性 | 值 |
|------|-----|
| **角色** | 执行层决策者，管理所有持仓的全生命周期 |
| **调用频率** | 每30秒-1分钟（或有持仓时） |
| **输入** | 所有持仓详情 + 当前价格 + 首席分析师方向 + 入场策略师最新信号 |
| **输出** | 针对每个持仓的操作指令 |
| **Token预算** | 约 2K-3K（精简） |
| **核心Prompt** | "你是持仓管理专家，让利润奔跑同时控制风险" |

**输出格式（针对每个持仓）:**
```json
{
  "ticket": 12345,
  "action": "HOLD|TRAIL_SL|MOVE_BE|PARTIAL_CLOSE|CLOSE|ADD",
  "new_sl": price,
  "new_tp": price,
  "close_percent": 0-100,
  "add_lots": 0.0,
  "reason": "20字操作理由"
}
```

**关键能力:**
- 分级止盈（盈利0.3%平30%，0.6%平30%，1.0%追踪剩余）
- 智能移动止损（基于结构而非固定点数）
- 顺势加仓（趋势延续时金字塔加仓）
- 反向信号减仓（部分平仓而非全平）
- 持仓健康度评估

#### Agent 4: 风险控制官 (Risk Officer Agent)

| 属性 | 值 |
|------|-----|
| **角色** | 独立风控，监控所有Agent决策和账户状态 |
| **调用频率** | 每日开盘 + 每小时巡检 + 事件触发 |
| **输入** | 账户状态 + 持仓汇总 + 近期交易统计 + 市场波动率 |
| **输出** | 风控参数调整建议 + 交易许可/禁止 |
| **Token预算** | 约 2K |
| **核心Prompt** | "你是严格的风险控制官，保护资本是第一优先级" |

**输出格式:**
```json
{
  "trading_allowed": true|false,
  "max_positions_today": int,
  "max_risk_per_trade_pct": double,
  "daily_loss_limit": double,
  "daily_profit_target": double,
  "cooldown_seconds": int,
  "warnings": ["警告1", "警告2"],
  "adjustments": "参数调整说明"
}
```

#### Agent 5: 复盘学习员 (Review & Learning Agent)

| 属性 | 值 |
|------|-----|
| **角色** | 离线分析员，定期复盘并优化策略 |
| **调用频率** | 每日收盘后 + 每周一次深度复盘 |
| **输入** | 当日/当周所有交易记录 + 决策时上下文 + 结果 |
| **输出** | 策略优化建议 + 参数调整 + 模式识别 |
| **Token预算** | 约 6K-10K |
| **核心Prompt** | "你是交易策略优化师，从历史交易中学习并改进" |

**输出格式:**
```json
{
  "performance_summary": "当日表现总结",
  "wins_analysis": "盈利交易模式",
  "losses_analysis": "亏损交易模式",
  "parameter_suggestions": {
    "ai_confidence_min": 0.65,
    "stop_loss_atr_mult": 2.5,
    "trailing_distance": 30
  },
  "strategy_notes": "策略改进建议",
  "lessons_learned": ["教训1", "教训2"]
}
```

#### Agent 6: 事件监控员 (Event Monitor Agent)

| 属性 | 值 |
|------|-----|
| **角色** | 经济事件哨兵，识别高风险时段 |
| **调用频率** | 每小时检查 + 事件前15分钟预警 |
| **输入** | 经济日历（需外部数据源） + 当前时间 |
| **输出** | 事件预警 + 风险等级 + 操作建议 |
| **Token预算** | 约 1K-2K |

### 4.3 Agent协作流程

#### 场景1：正常交易流程
```
[15分钟] 首席分析师 → 市场报告 → 写入共享状态
     ↓
[3-5分钟] 入场策略师 → 读取市场报告 → 生成入场信号
     ↓
[执行] 执行网关 → 安全检查 → 下单
     ↓
[30秒-1分钟] 持仓管理者 → 监控持仓 → 移动止损/部分平仓
     ↓
[平仓] 统计更新 → 通知复盘学习员
     ↓
[每日] 复盘学习员 → 分析 → 优化参数 → 通知风险控制官
```

#### 场景2：突发事件
```
事件监控员 → 检测到NFP发布
     ↓
广播: "HIGH_IMPACT_EVENT_IN_15MIN"
     ↓
风险控制官 → 禁止新开仓
持仓管理者 → 评估现有持仓是否减仓
     ↓
事件过后 → 风险控制官恢复交易许可
```

#### 场景3：API故障
```
某Agent调用失败
     ↓
重试3次（指数退避）
     ↓
仍失败 → 降级到规则引擎（保留上一轮AI决策）
     ↓
记录故障 → 通知风险控制官 → 可能降低仓位
```

### 4.4 共享状态设计

```mql5
// 共享状态结构（消息总线）
struct AgentSharedState {
    // 市场状态（首席分析师维护）
    string     market_regime;        // TRENDING_UP/DOWN/RANGING/VOLATILE
    string     market_bias;          // BULLISH/BEARISH/NEUTRAL
    double     regime_confidence;    // 0-1
    double     key_supports[5];      // 关键支撑位
    double     key_resistances[5];   // 关键阻力位
    string     market_narrative;     // 市场叙事
    datetime   analyst_update_time;  // 最后更新时间
    
    // 入场信号（入场策略师维护）
    string     entry_signal;         // BUY/SELL/WAIT
    double     entry_confidence;     // 0-1
    string     entry_type;           // BREAKOUT/PULLBACK/...
    int        suggested_sl_points;
    int        suggested_tp_points;
    double     size_factor;          // 0.5-2.0
    datetime   entry_update_time;
    
    // 风控参数（风险控制官维护）
    bool       trading_allowed;
    int        max_positions;
    double     max_risk_per_trade;
    double     daily_loss_limit;
    double     daily_profit_target;
    int        cooldown_seconds;
    datetime   risk_update_time;
    
    // 学习成果（复盘学习员维护）
    double     adjusted_confidence_min;
    double     adjusted_sl_atr_mult;
    string     recent_lessons[5];
    datetime   learning_update_time;
    
    // 事件状态（事件监控员维护）
    string     next_high_impact_event;
    datetime   event_time;
    bool       event_lock;           // 事件期间禁止交易
};
```

---

## 五、分阶段开发路线图

### Phase 1: 持仓管理AI化（最高优先级）

> **目标**: 把持仓管理从硬编码改为AI驱动
> **预计工时**: 2-3天
> **价值**: 最高（解决最薄弱环节）

#### 任务清单

- [ ] **T1.1** 重构 `ManageAIPositions()` 为AI驱动
  - 新增 `CallPositionManager()` 函数
  - 构建持仓专用上下文（精简版）
  - 解析AI返回的操作指令
  - 执行 HOLD/TRAIL_SL/MOVE_BE/PARTIAL_CLOSE/CLOSE/ADD

- [ ] **T1.2** 实现分级止盈
  - 盈利 0.3% → 平仓30%
  - 盈利 0.6% → 再平30%
  - 盈利 1.0%+ → 追踪止损保护剩余

- [ ] **T1.3** 实现智能移动止损
  - 基于市场结构（前低/前高）而非固定点数
  - AI决定止损移动时机和位置

- [ ] **T1.4** 实现顺势加仓
  - 趋势延续 + 已盈利 + AI确认 → 加仓
  - 加仓量递减（金字塔）
  - 加仓后整体止损上移

- [ ] **T1.5** 持仓管理安全网
  - 硬编码最大单笔亏损限制（不可被AI突破）
  - 硬编码最大持仓时间限制
  - AI指令合理性校验

### Phase 2: 多Agent架构搭建

> **目标**: 拆分单一AI为多个专业Agent
> **预计工时**: 3-4天
> **价值**: 高（提升决策质量）

#### 任务清单

- [ ] **T2.1** 实现共享状态结构 `AgentSharedState`
- [ ] **T2.2** 实现首席分析师Agent
  - 15分钟调用周期
  - D1/H4/H1数据分析
  - 输出市场报告
- [ ] **T2.3** 重构入场策略师Agent
  - 基于首席分析师报告
  - 3-5分钟调用周期
  - M15/M5/M1精准入场
- [ ] **T2.4** 实现风险控制官Agent
  - 每日开盘调用
  - 动态调整风控参数
  - 交易许可仲裁
- [ ] **T2.5** Agent调度器
  - 基于时间的调度
  - 基于事件的触发
  - 并发调用管理

### Phase 3: 外部数据集成

> **目标**: 为AI提供黄金关联市场数据
> **预计工时**: 2-3天
> **价值**: 高（提升分析深度）

#### 任务清单

- [ ] **T3.1** 集成美元指数(DXY)
  - 通过MT5品种 `USDX` 或 `DXY`
  - 计算黄金-DXY相关性
  - 加入AI上下文
- [ ] **T3.2** 集成美债收益率
  - US10Y / US02Y
  - 实际收益率 = 名义收益率 - 通胀预期
- [ ] **T3.3** 集成经济日历
  - 通过WebFetch获取财经日历
  - 识别高影响事件（NFP/CPI/FOMC）
  - 事件前后自动调整策略
- [ ] **T3.4** 计算VIX替代指标
  - 基于黄金ATR历史百分位
  - 作为避险情绪代理

### Phase 4: 记忆与学习系统

> **目标**: 让AI能学习和自我优化
> **预计工时**: 3-4天
> **价值**: 中高（长期竞争力）

#### 任务清单

- [ ] **T4.1** 交易日志结构化存储
  - 记录每笔交易的完整上下文
  - 入场时所有指标值、AI分析、市场状态
  - 出场时盈亏、持仓时间、最大浮盈/浮亏
- [ ] **T4.2** 实现复盘学习员Agent
  - 每日收盘后调用
  - 分析当日交易
  - 输出参数优化建议
- [ ] **T4.3** 参数自适应机制
  - 学习员的建议写入共享状态
  - 其他Agent读取调整后的参数
  - 人工审核开关（可选）
- [ ] **T4.4** 模式识别库
  - 识别盈利交易共性
  - 识别亏损交易共性
  - 形成交易规则库

### Phase 5: 执行优化与健壮性

> **目标**: 提升系统稳定性和执行效率
> **预计工时**: 2-3天
> **价值**: 中（工程必须）

#### 任务清单

- [ ] **T5.1** API调用优化
  - 异步调用（不阻塞主循环）
  - 请求队列管理
  - Token预算控制
- [ ] **T5.2** 上下文压缩
  - 不同Agent不同精度
  - K线数据摘要化
  - 历史数据缓存
- [ ] **T5.3** 失败处理增强
  - 指数退避重试
  - 多模型降级（deepseek-chat → deepseek-reasoner → 规则）
  - 故障告警
- [ ] **T5.4** 性能优化
  - 持仓管理Agent用精简上下文
  - 减少不必要的Print日志
  - 优化数组操作

### Phase 6: 黄金交易专业能力强化

> **目标**: 注入黄金交易领域专家知识
> **预计工时**: 2天
> **价值**: 中（提升胜率）

#### 任务清单

- [ ] **T6.1** 黄金市场结构知识库
  - 伦敦定盘价时段
  - COMEX期货交割日
  - 央行购金数据
- [ ] **T6.2** 黄金季节性模式
  - 印度婚礼季（10-12月）
  - 中国春节（1-2月）
  - 夏季低迷期
- [ ] **T6.3** 黄金-美元联动模型
  - 实时相关性计算
  - 背离预警
  - 联动交易信号
- [ ] **T6.4** 流动性分析
  - 识别流动性真空区
  - 止损猎取识别
  - 大单冲击识别

---

## 六、技术实现要点

### 6.1 持仓管理Agent实现示例

```mql5
//+------------------------------------------------------------------+
//| 持仓管理Agent - 管理所有持仓的全生命周期                          |
//+------------------------------------------------------------------+
void CallPositionManager()
{
    if(!InpUseAI || !g_AIIsActive) return;
    
    // 节流: 30秒最多一次
    static datetime lastCall = 0;
    if(TimeCurrent() - lastCall < 30) return;
    lastCall = TimeCurrent();
    
    // 构建持仓上下文（精简）
    string context = BuildPositionContext();
    if(StringLen(context) == 0) return; // 无持仓
    
    // 调用AI
    string response = CallAIAgent("position_manager", context, 2000);
    
    // 解析并执行指令
    ExecutePositionActions(response);
}

string BuildPositionContext()
{
    string ctx = "";
    ctx += "当前持仓:\n";
    
    for(int i = PositionsTotal() - 1; i >= 0; i--)
    {
        ulong ticket = PositionGetTicket(i);
        if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol 
           && PositionGetInteger(POSITION_MAGIC) == 123456)
        {
            // 精简持仓信息
            ctx += StringFormat("#%I64u %s 入场:%.2f 当前:%.2f SL:%.2f 盈亏:%.2f$ (%.2f%%)\n",
                ticket,
                PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL",
                PositionGetDouble(POSITION_PRICE_OPEN),
                PositionGetDouble(POSITION_PRICE_CURRENT),
                PositionGetDouble(POSITION_SL),
                PositionGetDouble(POSITION_PROFIT),
                /* 计算百分比 */ 0.0
            );
        }
    }
    
    // 加入市场状态摘要
    ctx += StringFormat("市场: %s | 偏好: %s\n", 
        g_SharedState.market_regime, g_SharedState.market_bias);
    
    // 操作指令格式
    ctx += "\n对每个持仓给出操作指令(JSON数组):\n";
    ctx += "[{\"ticket\":12345,\"action\":\"HOLD/TRAIL_SL/MOVE_BE/PARTIAL_CLOSE/CLOSE/ADD\",...}]";
    
    return ctx;
}
```

### 6.2 上下文压缩策略

| Agent | K线数据 | 指标 | 持仓 | 总Token |
|-------|---------|------|------|---------|
| 首席分析师 | D1:30 + H4:20 + H1:30（紧凑） | 完整历史 | 汇总 | ~5K |
| 入场策略师 | M15:20 + M5:20 + M1:10（紧凑） | 当前值 | 当前持仓 | ~4K |
| 持仓管理者 | M5:5 + M1:5（极简） | 仅RSI/ATR当前 | 完整详情 | ~2K |
| 风险控制官 | 无K线 | 仅统计 | 汇总 | ~1.5K |
| 复盘学习员 | 无K线 | 交易记录 | 历史汇总 | ~8K |

**压缩技巧:**
```
完整格式: "+3285.50:3200/3250:120r:1500v[高量] | -3280.30:3290/3270:80r:800v"
压缩格式: "U3285.5 H3200 L3250 R120 V1500 | D3280.3 R80 V800"
极简格式: "U+120 | D-80 | U+90"  (仅方向+振幅)
```

### 6.3 安全网设计

```mql5
//+------------------------------------------------------------------+
//| 硬编码安全网 - AI无法突破的底线                                   |
//+------------------------------------------------------------------+
bool ValidateAIAction(ulong ticket, string action, double param)
{
    // 1. 单笔最大亏损检查
    double maxLoss = AccountInfoDouble(ACCOUNT_EQUITY) * 0.02; // 2%
    double currentLoss = -PositionGetDouble(POSITION_PROFIT);
    if(currentLoss > maxLoss && action != "CLOSE")
    {
        Print("🚨 安全网: 单笔亏损超限，强制平仓");
        return false; // 强制CLOSE
    }
    
    // 2. 止损只能向有利方向移动
    if(action == "TRAIL_SL" || action == "MOVE_BE")
    {
        double currentSL = PositionGetDouble(POSITION_SL);
        ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
        if(type == POSITION_TYPE_BUY && param < currentSL) return false;
        if(type == POSITION_TYPE_SELL && param > currentSL && currentSL > 0) return false;
    }
    
    // 3. 加仓总量限制
    if(action == "ADD")
    {
        double totalExposure = CalculateTotalExposure();
        double maxExposure = AccountInfoDouble(ACCOUNT_EQUITY) * 0.1; // 10%
        if(totalExposure + param > maxExposure) return false;
    }
    
    // 4. 持仓时间上限
    datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
    if(TimeCurrent() - openTime > 86400 && action == "HOLD") // 24小时
    {
        Print("🚨 安全网: 持仓超24小时，建议平仓");
        // 不强制，但提醒
    }
    
    return true;
}
```

### 6.4 API调用优化

```mql5
//+------------------------------------------------------------------+
//| 统一Agent调用入口                                                 |
//+------------------------------------------------------------------+
string CallAIAgent(string agentRole, string context, int maxTokens)
{
    // 1. 检查API预算
    if(!CheckAPIBudget(agentRole)) 
    {
        return GetFallbackResponse(agentRole);
    }
    
    // 2. 选择模型（按角色）
    string model = SelectModelByRole(agentRole);
    
    // 3. 构建请求
    string systemPrompt = GetSystemPrompt(agentRole);
    string json = BuildJSONRequest(model, systemPrompt, context, maxTokens);
    
    // 4. 重试机制
    for(int attempt = 0; attempt < 3; attempt++)
    {
        string response = SendAPIRequest(json);
        if(StringLen(response) > 0) return response;
        
        // 指数退避
        Sleep(1000 * (int)MathPow(2, attempt));
    }
    
    // 5. 降级
    return GetFallbackResponse(agentRole);
}

string SelectModelByRole(string role)
{
    // 首席分析师用强推理模型
    if(role == "chief_analyst") return "deepseek-reasoner";
    // 复盘学习员用强推理模型
    if(role == "reviewer") return "deepseek-reasoner";
    // 其他用快速模型
    return "deepseek-chat";
}
```

---

## 七、黄金交易领域知识注入

### 7.1 黄金市场关键特性

#### 7.1.1 时段特性（北京时间）
| 时段 | 时间 | 特性 | 策略 |
|------|------|------|------|
| 悉尼 | 06:00-14:00 | 流动性低，波动小 | 观望或小仓位区间 |
| 东京 | 08:00-16:00 | 略有波动 | 同上 |
| 伦敦 | 15:00-23:00 | 波动放大 | 适合入场 |
| 纽约 | 21:00-05:00 | 波动最大 | 最佳交易时段 |
| 重叠 | 21:00-23:00 | **黄金时段** | 重点出击 |

#### 7.1.2 关键价位类型
- **年度高点/低点**: 强阻力/支撑
- **月度高低**: 中期关键位
- **整数关口**: 3000, 3100, 3200...（心理位）
- **斐波那契回撤**: 38.2%, 50%, 61.8%
- **前日高低**: 日内参考
- **亚盘高低**: 伦敦突破参考

#### 7.1.3 黄金特有形态
- **伦敦突破**: 亚盘区间突破后顺势
- **纽约反转**: 纽约开盘反向运动
- **假突破扫损**: 突破关键位后快速回落
- **避险拉升**: 地缘事件急涨
- **美元压制**: DXY走强时黄金承压

### 7.2 黄金交易Prompt增强

应注入首席分析师的System Prompt：

```
【黄金市场专业知识】
1. 黄金与美元指数(DXY)负相关（-0.7~-0.9）
2. 黄金与美债实际收益率负相关
3. 黄金是避险资产，地缘政治事件会推升金价
4. 黄金以美元计价，美元走强通常压制金价

【黄金关键时段（北京时间）】
- 06:00-14:00 亚盘：低波动，适合区间
- 15:00-23:00 伦敦：波动放大
- 21:00-23:00 伦敦+纽约重叠：最佳时段
- 21:30-22:30 美国数据发布高峰：高波动

【黄金交易禁忌】
- 避免在NFP/CPI/FOMC前15分钟建仓
- 避免在亚盘凌晨2-5点（GMT）交易
- 周五21:00后不建议建新仓（周末风险）
- 单边急涨/急跌后不追（等回踩）

【黄金止损原则】
- 日内交易：ATR的1.5-2倍
- 波段交易：ATR的2-3倍
- 止损放在结构位之外（前低下方/前高上方）
- 避免整数关口止损（易被扫）
```

### 7.3 DXY联动信号

```mql5
//+------------------------------------------------------------------+
//| 计算黄金-DXY相关性                                                |
//+------------------------------------------------------------------+
double CalculateGoldDXYCorrelation(int period)
{
    double goldClose[], dxyClose[];
    ArraySetAsSeries(goldClose, true);
    ArraySetAsSeries(dxyClose, true);
    
    if(CopyClose(_Symbol, PERIOD_H1, 0, period, goldClose) != period) return 0;
    if(CopyClose("USDX", PERIOD_H1, 0, period, dxyClose) != period) return 0;
    
    // 计算皮尔逊相关系数
    double goldMean = 0, dxyMean = 0;
    for(int i = 0; i < period; i++)
    {
        goldMean += goldClose[i];
        dxyMean += dxyClose[i];
    }
    goldMean /= period;
    dxyMean /= period;
    
    double numerator = 0, goldVar = 0, dxyVar = 0;
    for(int i = 0; i < period; i++)
    {
        double gd = goldClose[i] - goldMean;
        double dd = dxyClose[i] - dxyMean;
        numerator += gd * dd;
        goldVar += gd * gd;
        dxyVar += dd * dd;
    }
    
    double denominator = MathSqrt(goldVar * dxyVar);
    if(denominator == 0) return 0;
    
    return numerator / denominator;
}
```

---

## 八、风险与对策

### 8.1 技术风险

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| DeepSeek API宕机 | 中 | 高 | 多模型降级 + 规则引擎兜底 |
| API延迟过高 | 高 | 中 | 异步调用 + 超时熔断 |
| Token消耗超预算 | 中 | 中 | 预算控制 + 上下文压缩 |
| AI给出错误指令 | 中 | 高 | 安全网校验 + 人工审核开关 |
| MT5品种不可用(USDX) | 中 | 低 | 降级到纯技术分析 |

### 8.2 交易风险

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| AI过度交易 | 高 | 高 | 风险控制官强制冷却 |
| 持仓集中(同向) | 高 | 高 | 相关性风控 + 净敞口限制 |
| 黑天鹅事件 | 低 | 极高 | 事件监控 + 硬止损 + 降仓 |
| 周末跳空 | 中 | 高 | 周五减仓 + 不持仓过周末(可选) |
| 流动性枯竭 | 中 | 高 | 时段过滤 + 点差监控 |

### 8.3 风险递进控制

```
Level 0: AI正常决策
    ↓ 触发条件: 单笔亏损 > 1.5%
Level 1: 减少仓位50%，提高置信度阈值到0.70
    ↓ 触发条件: 单笔亏损 > 2% 或 日亏损 > 3%
Level 2: 禁止新开仓，仅管理现有持仓
    ↓ 触发条件: 日亏损 > 5% 或 连续亏损3次
Level 3: 全部平仓，停止交易24小时
    ↓ 触发条件: 日亏损 > 8% 或 爆仓风险
Level 4: 永久停止，人工介入
```

---

## 九、验收标准与KPI

### 9.1 各阶段验收标准

#### Phase 1 验收
- [ ] 持仓管理Agent能对每个持仓给出操作建议
- [ ] 分级止盈功能正常运行
- [ ] 智能止损移动至少比固定追踪止损提升5%胜率（回测）
- [ ] 安全网成功拦截所有越界指令

#### Phase 2 验收
- [ ] 5个Agent独立运行，互不阻塞
- [ ] 共享状态正确传递
- [ ] Agent调度器无冲突
- [ ] 单Agent故障不影响其他Agent

#### Phase 3 验收
- [ ] DXY数据成功集成
- [ ] 经济日历事件正确识别
- [ ] 事件期间自动禁交易

#### Phase 4 验收
- [ ] 交易日志完整记录
- [ ] 复盘Agent能给出可执行的优化建议
- [ ] 参数自适应不导致策略漂移

### 9.2 性能KPI

| 指标 | 当前(V3.2) | 目标(V4.0) |
|------|-----------|-----------|
| AI参与度 | 25% | 85% |
| API平均延迟 | 5-10秒 | <3秒 |
| Token消耗/日 | ~200K | <150K |
| 持仓管理胜率 | 待测 | 提升10%+ |
| 最大回撤 | 待测 | <8% |
| 系统可用性 | 95% | 99% |
| Profit Factor | 待测 | >1.5 |

### 9.3 交易KPI

| 指标 | 目标值 |
|------|--------|
| 月度收益率 | >3% |
| 最大单笔亏损 | <2% |
| 最大日亏损 | <5% |
| 胜率 | >55% |
| 盈亏比 | >1.3 |
| 平均持仓时间 | 2-8小时 |
| 日均交易次数 | 2-5次 |

---

## 十、附录

### 10.1 文件结构规划

```
源流策略源码合集/
├── 源流AI交易版本-仅供交流学习.mq5     # V3.2 当前版本（保留）
├── 源流AI交易系统V4.mq5                # V4.0 新版本（开发中）
├── 源流AI交易系统-改进开发计划.md       # 本文档
├── agents/                              # Agent配置（可选）
│   ├── chief_analyst_prompt.txt
│   ├── entry_strategist_prompt.txt
│   ├── position_manager_prompt.txt
│   ├── risk_officer_prompt.txt
│   └── reviewer_prompt.txt
└── docs/                                # 文档
    ├── 架构图.md
    ├── Agent通信协议.md
    └── 回测报告.md
```

### 10.2 开发优先级矩阵

```
        高影响
          │
  Phase1  │  Phase2
  (持仓)  │  (多Agent)
          │
 ─────────┼───────── 高紧迫
          │
  Phase5  │  Phase3
  (健壮性)│  (外部数据)
          │
        低影响
    
低紧迫                高紧迫
```

**建议开发顺序**: Phase1 → Phase2 → Phase5 → Phase3 → Phase4 → Phase6

### 10.3 关键决策点

1. **是否持仓过周末?**
   - 建议: 默认不过，可配置
   - 理由: 黄金周末跳空风险大

2. **是否允许AI加仓?**
   - 建议: 允许但严格限制（最多1次加仓，金字塔减量）
   - 理由: 顺势加仓是利润放大器，但也是风险放大器

3. **复盘学习员的建议是否自动应用?**
   - 建议: 默认人工审核，可配置自动应用
   - 理由: 防止AI过度自信导致策略漂移

4. **是否使用deepseek-reasoner?**
   - 建议: 首席分析师和复盘学习员用reasoner，其他用chat
   - 理由: 平衡质量和成本

---

## 结语

本计划将"源流AI交易系统"从 **30% AI参与的单点决策系统** 升级为 **85% AI参与的多Agent协作系统**。

核心突破在于:
1. **持仓管理AI化** —— 让AI掌管交易全生命周期
2. **多Agent分工** —— 专业人做专业事
3. **记忆与学习** —— AI能从错误中成长
4. **黄金领域知识** —— 注入十年交易智慧
5. **分层安全网** —— AI自由但底线不可破

**下一步行动**: 按优先级开始 Phase 1（持仓管理AI化），这是投入产出比最高的改进。

---

*文档结束 | 源流AI交易系统 V4.0 改进开发计划 v1.0*
