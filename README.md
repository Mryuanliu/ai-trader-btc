# AI Trader · 策略托管平台（BTC 合约）

一个只做三件事的交易平台：**绑定交易所、下单交易、监控订单**。

交易逻辑全部由**挂载的策略**自行负责 —— 平台不做决策，也不做任何风控。

> 2026-09-23 起项目定位为「策略托管平台」：原决策引擎（指标信号 → 策略插件 → 产出 BUY/SELL/HOLD）、
> 全局风控（杠杆钳制 / 熔断 / 敞口限制 / 强平距离）、回测引擎均已移除。
> 设计决策与实施记录见 `docs/slim-martingale-refactor-plan.md`。

---

## 平台边界（重要）

| 能力 | 归属 |
|---|---|
| 绑定交易所（API Key / 测试网 / 账户） | ✅ 平台 |
| 下单交易（开仓 / 平仓 / 撤单 / 挂单 / 成交对账） | ✅ 平台 |
| 监控订单（持仓 / 仓位单 / 成交 / 盈亏） | ✅ 平台 |
| AI 行情解读（独立页面，**不参与下单**） | ✅ 平台 |
| **风控**（层数 / 敞口 / 杠杆上限 / 熔断 / 日亏损） | ❌ 由策略自负 |
| **决策**（何时开仓、加仓、出场） | ❌ 由策略自负 |

平台侧只保留「必然失败」的参数拦截：最小名义价值、数量/价格精度取整。
这类校验属于「指令能否送达交易所」，不是风控策略。

---

## 快速开始

### 1. 准备数据库

```bash
createdb ai_trader          # PostgreSQL 16
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，至少填这几项：

```bash
DB_HOST=localhost
DB_USERNAME=postgres
DB_PASSWORD=你的密码
DB_DATABASE=ai_trader

# 币安合约（demo = testnet，同一套环境）
BINANCE_FUTURES_API_KEY=
BINANCE_FUTURES_API_SECRET=
BINANCE_FUTURES_TESTNET=true

# 运行模式：dry_run（本地模拟）/ testnet（币安测试网）/ live（实盘）
APP_RUN_MODE=dry_run

# AI 行情（可选，不配则「AI 行情」页只显示本地指标）
LLM_ENABLED=true
LLM_API_KEY=
LLM_MODEL=deepseek-chat
```

### 3. 安装依赖并启动

```bash
pnpm install
pnpm --filter @ai-trader/shared build     # shared 改动后必跑
pnpm --filter server migration:run        # 数据库迁移（不会自动执行）
pnpm --filter server build && node apps/server/dist/main.js   # 后端 :3001
pnpm --filter web dev                     # 前端 :5173
```

> ⚠️ 后端跑的是**编译产物**（`node apps/server/dist/main.js`，工作目录为仓库根）。
> 改完代码必须 `pnpm --filter server build` **并重启**才生效，它不是 watch 模式。
> `migrationsRun: false` —— 新增迁移必须手动 `pnpm --filter server migration:run`。

默认账号见 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（首次启动自动创建）。

---

## 运行模式

| 模式 | 行为 |
|---|---|
| `dry_run` | 完全本地模拟：不触交易所，挂单由调度器按行情模拟触发，成交与盈亏记账与实盘同路径（只差真实滑点） |
| `testnet` | 真实发单到币安测试网（demo-fapi），用虚拟资金 |
| `live` | 真实资金 |

**切到 `live` 时前端会弹二次确认**（提示会用真实资金自动下单、平台不拦截任何交易）。
切换运行模式会撤销已有未成交挂单，避免两种模式下的单子混在一起无法对账。

---

## 架构

```
Scheduler（每 5 秒）
  ├─ 行情喂入 / 新闻抓取
  ├─ syncPendingFills()      合约成交对账：回查交易所，补记 trade_fills 与 Lot
  ├─ 触发 dry-run 挂单        按行情模拟触发 STOP 单
  └─ StrategyRunner.tick()
        ├─ 构造 StrategyContext（价格 / ATR / K 线 / 未完结仓位单 / 挂单 / 可用保证金）
        └─ 挂载的 Strategy.onTick(ctx, executor)
              ├─ executor.placeStopOrder()  挂网格待成交层
              ├─ executor.closeLot()        全量平掉某仓位单
              └─ executor.cancelOrder()     撤单
```

**策略是有状态的常驻对象**，不是「产出信号的纯函数」。契约见 `apps/server/src/strategy/types.ts`：

```ts
interface TradingStrategy {
  readonly name: string;
  normalizeParams(raw): Record<string, unknown>;
  onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void>;
  getState(): Record<string, unknown>;
}
```

平台同一时间只允许挂载**一个**策略；启动前若存在未完结仓位单会被拦下并列出明细
（那是上一个策略留下的仓位，需要手动了结，否则两套策略的仓位无法归因）。

停止策略会**撤销未成交挂单**（否则策略已下线却仍可能被触发开仓），
但**不动已成交的持仓** —— 那是用户自己的仓位。

### 仓位单（Position Lot）模型

- 每笔**开仓订单 = 一个 Lot**，平仓必须**全量平掉**，不做部分平仓。
- 1 开仓单 ↔ 1 Lot ↔ 1 平仓单，回合配对不依赖 FIFO 启发式。
- hedge 模式下多空 Lot 可共存（锁仓）。
- **平台不设也不扫描逐层止盈止损** —— 出场由策略决定。

### AI 的角色

AI 只出现在「AI 行情」页：输入行情 + 新闻，输出市场状态解读（趋势/震荡/高波动、情绪、点评）。
**输出不进入任何下单路径**，纯展示。

---

## 内置策略：马丁网格

移植自黄金 EA `king-v4-balance.mq5`，忠于原始语义：

| 机制 | 说明 |
|---|---|
| **双向 STOP 挂单** | 无持仓即挂首层：上方 `BUY_STOP`、下方 `SELL_STOP`，**谁的价先被突破谁成交** |
| **加层等回归确认** | 价格相对**最不利持仓**再走远 2 个网格，才在现价外侧挂突破单（不是"跌了就摊平"） |
| **单侧金字塔** | 默认只在一侧持仓，另一侧挂单会被撤掉 |
| **篮子追踪止盈** | 不设逐层止盈，只看整篮子净收益（扣平仓成本）达到阈值后跟踪峰值，回撤即全平 |
| **动态倍率/间距** | ATR 驱动；震荡区倍率 1.5、趋势区压到 1.1 |

默认参数：每侧 6 层、倍率 1.5、首层数量 0.001 BTC、杠杆 5x。
参数可在「策略管理」页按策略单独配置（前端按 JSON Schema 动态渲染表单）。

---

## 目录结构

```
apps/
  server/                 Nest.js 后端
    src/strategy/         策略层：契约 / 马丁网格 / 运行器 / 执行器 / HTTP 接口
    src/futures/          合约执行：下单唯一出口 / 持仓 / 配置
    src/account/          仓位单（Lot）服务 / 持仓推导
    src/market/           行情（合约 K 线与报价，本地缓存 + 实时订阅）
    src/exchanges/        交易所适配器（binance-futures）与注册表
    src/trading/          订单查询与记账
    src/scheduler/        主循环
    src/database/         实体与迁移
  web/                    Vite + React + antd
    src/pages/admin/      总览 / 策略管理 / AI 行情 / 合约面板 / 新闻 / 账户
    src/pages/mobile/     移动端：资产 / 交易 / 策略
packages/
  shared/                 前后端共享类型与纯函数（指标、下单归一化、持仓推导）
docs/
  slim-martingale-refactor-plan.md   当前架构方案与实施记录
  binance-api/                       币安接口笔记
```

---

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/overview` | 总览聚合（行情 / 余额 / 今日盈亏 / 近期订单） |
| `GET` | `/api/strategy` | 策略合集 |
| `GET` | `/api/strategy/status` | 运行状态 |
| `POST` | `/api/strategy/start` | 启动策略（有未平仓单时返回 `blockingLots` 明细） |
| `POST` | `/api/strategy/stop` | 停止策略（撤销挂单，保留持仓） |
| `GET` | `/api/ai/market` | AI 行情解读（`force=true` 绕缓存） |
| `GET/PATCH` | `/api/futures/config` | 合约配置（模式 / 杠杆 / 保证金比例） |
| `GET` | `/api/futures/positions` | 持仓（以交易所 positionRisk 为权威） |
| `POST` | `/api/futures/order` | 手动下单（带 `lotId` 即全量平该仓位单） |
| `GET` | `/api/futures/orders` | 合约订单（含挂单） |
| `GET` | `/api/lots` | 仓位单列表 |
| `GET` | `/api/orders` | 订单分页（监控用） |

---

## 币安合约 API 踩坑（改合约代码前必看）

1. `marginType` 必须大写（`ISOLATED`/`CROSS`），小写报 -1102（文案误导，实为值校验失败）。
2. **单向持仓下禁传 `positionSide`（-4061）；双向持仓下禁传 `reduceOnly`（-1106）** ——
   适配器按 `positionMode` 分流。挂 STOP 单必须带 `positionSide`，所以启动策略前会确保账户是 hedge 模式。
3. `POST /fapi/v1/order` 响应**不含 avgPrice/cumQuote**，成交价需回查 `GET /fapi/v1/order`。
4. demo 环境下单响应常为 `status=NEW` / `executedQty=0`（异步成交）→ 靠 `syncPendingFills()`
   回查对账补记成交与 Lot。**挂单（STOP_MARKET）也走这条对账**，所以它的候选必须包含 `status=NEW`。
5. 幂等错误 -4028 / -4046 当成功。
6. `STOP_MARKET` 语义：BUY 在价格**上破** stopPrice 成交、SELL **下破**成交（即 MT5 的 BuyStop/SellStop）。
7. `minNotional` 各标的不同（BTCUSDT=50），用 `exchangeInfo` 不要硬编码。

### 手续费与盈亏口径

- 下单用 `newOrderRespType=FULL` 取 `fills[].commission`，`sumCommissionUsdt()` 折算为 USDT；
  取不到时按费率估算 —— **绝不记 0**（记 0 会把毛盈亏当成净盈亏）。
- 总览「今日盈亏」= 今日平仓回合 `netPnl` 之和（已实现）+ 当前持仓浮动盈亏。
  无成交无持仓时显示 `--` 而不是 0。

---

## 常用命令

```bash
pnpm --filter @ai-trader/shared build      # shared 改后必跑
pnpm --filter @ai-trader/shared test
pnpm --filter server typecheck
pnpm --filter server build
pnpm --filter server test                  # 策略核心逻辑单测
pnpm --filter server migration:run         # 新增迁移后执行
pnpm --filter web typecheck
pnpm --filter web build
```

**新增迁移前先确认号段**：`ls apps/server/src/database/migrations/`（当前已用至 14000）。

---

## 注意事项

- `.env` 含 API 密钥，不要提交；上线前替换默认管理员密码。
- 访问币安需要代理（见 `.env.example` 的代理配置）；`curl` 调本地接口时用 `-x ''` 绕过代理。
- 数据库当前保留 9 张表：`market_candles` / `news_items` / `orders` / `trade_fills` /
  `position_lots` / `exchange_accounts` / `futures_agent_configs` / `users` / `migrations`。
