# 开发交接 · 当前状态与下一步

> 最后更新：**2026-08-30**
> 面向场景：隔一段时间后接着开发，需要快速恢复上下文。

---

## 一、当前状态速览

| 模块 | 状态 | 备注 |
| --- | --- | --- |
| 现货全链路 | ✅ 完成 | 行情 / 决策 / 下单 / 风控 / 回测 |
| 决策链路两态 | ✅ 完成 | `strategy` / `hybrid`；`llm` 直出已移除 |
| 合约 Commit 1~7 | ✅ 完成 | 类型 / 迁移 / 适配器 / 执行器 / 引擎 / 回测 / 前端 |
| 合约 Commit 8（验收） | ⚠️ **未完成** | 用户接管自行验证，**建议推迟到策略 B 期后** |
| **策略诊断与增强** | 📋 **方案就绪，未实施** | **下一步就是它** |

### 三条不可违背的原则（改动前必读）

1. **AI 永不直接下达买卖指令。** `hybrid` 链路里 AI 只输出市场状态元参数
   （regime / 激进度 / 新闻情绪），由纯函数映射为策略参数，买卖仍由确定性策略执行。
   原 `llm` 链路已于 2026-08-30 移除。
2. **跨市场查询必须显式指定 `market`。** 现货与合约共用
   `orders` / `trade_fills` / `agent_decisions` 三张表，靠 `market` 列区分。
   任何聚合查询漏了 `market` 条件就会跨市场污染（已踩过：合约成交被推导成现货持仓）。
3. **架构上「纵向公用 / 横向隔离」。** L0~L3（数据/AI 上下文/指标信号/策略决策）现货合约共用；
   L4~L6（执行/风控/持仓）通过 `MarketExecutor` 接口隔离。新增市场只需实现 L4~L6。

---

## 二、下一步：策略诊断与增强

**完整方案：`docs/strategy-enhancement-plan.md`**（本文件只做索引，细节看那边）。

### 问题现象

历史 386 条决策：**BUY 0 次 / SELL 20 次 / HOLD 361 次**，HOLD 的 confidence 平均 **0.002**。

### 四个根因（按重要性）

| # | 根因 | 位置 |
| --- | --- | --- |
| 1 | **阈值 `0.85` 在六信号体系下数学上不可达** | `shared/src/strategy/trend-following.ts` + `indicators/signals.ts:177` |
| 2 | **RSI 语义与趋势策略冲突 → 多空偏置** | `indicators/signals.ts` RSI≥70 判 bearish |
| 3 | HOLD 时 `confidence` 硬编码为 0 | `trend-following.ts:61`、`mean-reversion.ts:115` |
| 4 | 缺「为什么没开单」的结构化归因 | 全链路 |

**根因 1 的要点**：六信号权重合计 1.0（ma_trend .25 / rsi .2 / macd .2 / boll .15 / volume .1 / mid_term .1），
而 `scoreSignals` **分子只累加非中性信号、分母却是全部权重**。
`bollinger` 在约 80% 时间是 neutral（仅 %b ≤0.1 或 ≥0.9 表态）→ 常态下最大 score 恰为 **0.85 卡死**；
若 rsi 也在 45~55 → 0.80；boll+volume 皆 neutral → 0.75；任一信号反向 → 0.60。**全部不触发。**

**根因 2 的要点**：RSI≥70 判 bearish 是**均值回归**口径。但 `trend_following` 是顺势策略——
上涨趋势中 RSI 常 >70，RSI 持续投反对票 → **趋势最强、最该做多时反而开不了多单**。
这是 BUY=0 的直接原因。

### 四期路线（A→B 必须先做）

| 期 | 目标 | 验收标准 | 前置 |
| --- | --- | --- | --- |
| **A** | 可观测 | 任意一条 HOLD 都能看到「原因码 + 差多少 + 谁拖后腿」，无需翻日志 | 无 |
| **B** | 修缺陷 | 镜像对称测试通过；BUY/SELL 不再 0:N 失衡；阈值扫描出平坦区间 | A |
| **C** | 验信号 | 每信号有 IC / t-stat / 分位收益；新权重样本外不劣于原权重 | B |
| **D** | 强能力 | 各因子单独回测 IC 显著（t-stat > 2）才准入 | C |

**为什么 A 必须先做**：A 期产出「每条 HOLD 为什么 HOLD」的完整数据。
没有它，B 期的阈值和口径怎么改只能靠推测。

---

## 三、数据现状与硬约束

| 数据 | 数量 | 时间跨度 | 可用性 |
| --- | --- | --- | --- |
| 现货 1m | 86,416 根 | 07-01 ~ 08-30 | ✅ 短周期研究 |
| 现货 5m | 17,331 根 | 07-01 ~ 08-30 | ✅ 勉强够参数校准 |
| 现货 15m | 405 根 | 08-26 ~ 08-30 | ❌ 不足以统计检验 |
| 现货 1h | 327 根 | 08-16 ~ 08-30 | ❌ 同上 |
| 现货 4h | 247 根 | 07-20 ~ 08-30 | ❌ 同上 |
| 现货 1d | 361 根 | 03-03 ~ 08-30 | ⚠️ 仅长周期参考 |
| **合约 15m** | **1,345 根** | **08-01 ~ 08-15** | ❌ **仅半个月，严重不足** |
| 历史决策 | 386 条 | 08-29 ~ 08-30（2 天） | ❌ 只能观察现象 |

**直接推论**：

- D 期的机器学习类方法（元标注）**当前不具备条件**，必然过拟合。
- 合约因子研究需先 `backfill` 到 **≥6 个月**。
- B 期阈值扫描**只能用 5m / 1m**。

---

## 四、环境配置速查

```bash
# 常用命令（在各包目录下执行，或用 -F 过滤）
pnpm --filter @ai-trader/shared build      # ⚠️ shared 改后必跑，否则 server/web 拿旧产物
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter web typecheck

cd apps/server && pnpm migration:run       # 迁移
cd apps/server && pnpm backtest -- --strategy=trend_following --interval=5m \
  --from=2026-06-01 --to=2026-08-01
cd apps/server && pnpm backtest -- --market=futures --leverage=5 --compare-leverage
```

**要点**：

- **Clash 代理 `127.0.0.1:7897`**，已写入 `~/.zshrc`；新终端自动生效，旧终端需 `source ~/.zshrc`。
- **node 原生 `fetch` 不走代理**，脚本里必须用 `axios + HttpsProxyAgent`（项目已封装 `axiosTransport`）。
- 数据库 PostgreSQL localhost，凭据在根目录 `.env`。
- **改 `packages/shared` 后必须 build**，否则 server/web 用的是旧产物（高频踩坑点）。

---

## 五、⚠️ 上线前必须处理

| 项 | 现状 | 风险 |
| --- | --- | --- |
| `ADMIN_PASSWORD=admin12345` | 仍是默认值，仓库可见 | 任何人可登录后台 |
| `JWT_SECRET=change-me-jwt-secret` | 仍是默认值，仓库可见 | 可伪造 JWT |

---

## 六、暂停/恢复交易

合约默认 `enabled=true` + `mode=testnet`，调度器每 300s 自动决策并可**真实下单**到币安合约 demo。

```bash
# 停止合约自动交易
curl -X PATCH http://localhost:3001/api/futures/config \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"enabled":false}'

# 停止现货自动交易
curl -X PATCH http://localhost:3001/api/agent/config \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

登录：`POST /api/auth/login` body `{username, password}` → 返回 `token`。

---

## 七、文档索引

| 文档 | 内容 |
| --- | --- |
| `README.md` | 项目总览、快速开始、架构、接口 |
| **`docs/strategy-enhancement-plan.md`** | **策略诊断与增强（下一步）** |
| `docs/futures-phase1-plan.md` | 合约接入方案（8 个 Commit，含 Commit 8 遗留说明） |
| `docs/decision-lanes-plan.md` | 决策链路设计 |
| `docs/decision-lanes-discussion.md` | 方案讨论记录（含 Q1~Q7 问答） |
| `docs/binance-api/` | 币安 API 参考（`llms-catalog.md` 可 grep 全量接口） |
| `.codebuddy/memory/MEMORY.md` | 长期记忆（跨会话稳定事实） |
| `.codebuddy/memory/YYYY-MM-DD.md` | 日常流水 |

---

## 八、恢复开发的第一件事

1. 读 `docs/strategy-enhancement-plan.md` 的第一部分（根因诊断）
2. 确认当前代码与文档描述一致（重点看 `indicators/signals.ts` 的 `scoreSignals`）
3. 从 **A 期（可观测）** 开始实施，先让 HOLD 能自解释
