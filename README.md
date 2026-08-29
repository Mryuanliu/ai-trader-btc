# AI Trader · 比特币智能交易系统

一套 AI 驱动的比特币自动交易系统：后端 Nest.js + PostgreSQL 桥接**币安**与**欧意（OKX）**自动下单，前端为单套 Vite + antd 响应式应用，按屏幕宽度切换**移动端钱包视图**与 **PC 后台管理视图**。

决策引擎采用「**技术指标信号 + LLM 终裁**」混合模式：指标先产出结构化信号，模型结合行情与新闻做最终裁决；模型不可用时自动降级为纯指标策略并标注。

---

## 快速开始

### 1. 准备数据库

本机已有 PostgreSQL 时，一键创建角色与数据库：

```bash
pnpm db:init          # 等价于 psql -d postgres -h localhost -f scripts/init-db.sql
```

使用 Docker 时：

```bash
docker compose up -d postgres
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

最小可用配置（**无需任何密钥**即可跑通全链路）：

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=ai_trader
DB_PASSWORD=ai_trader_pwd
DB_DATABASE=ai_trader
APP_RUN_MODE=dry_run
```

### 3. 安装依赖并启动

```bash
pnpm install
pnpm dev               # 同时启动后端 :3001 与前端 :5173
```

单独启动：

```bash
pnpm dev:server        # 仅后端
pnpm dev:web           # 仅前端
```

启动后访问：

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| PC 后台管理 | http://localhost:5173/admin | 宽度 ≥ 768px 自动进入 |
| 移动端钱包 | http://localhost:5173/m | 宽度 < 768px 自动进入 |
| 后端 API | http://localhost:3001/api | REST 接口 |
| WebSocket | ws://localhost:3001/realtime | 实时推送 |

默认管理员：`admin` / `admin12345`（由 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 决定，首次启动自动创建）。

### 4. 可选：写入演示种子数据

```bash
pnpm -F @ai-trader/server seed
```

---

## 运行模式

| 模式 | 说明 | 是否需要密钥 |
| --- | --- | --- |
| `dry_run` 模拟撮合 | 接实时行情，下单按当前市价**模拟撮合**并写库，不触达交易所 | 否 |
| `testnet` 模拟盘 / 测试网 | 真实下单到**账户环境**对应的主机（默认币安模拟盘） | 是 |
| `live` 实盘 | 真实资金下单，需携带二次确认 Token | 是 |

> 「运行模式」决定是否真实发单，「账户环境」决定发往哪个主机。例如运行模式 `testnet` + 账户环境 `demo` = 真实下单到币安模拟盘。
>
> 实盘模式下，Agent 的**定时轮询不会自动下单**（缺少二次确认 Token），仅手动调用 `POST /api/agent/run` 或手动下单接口且携带正确的 `LIVE_TRADING_CONFIRM_TOKEN` 时才会真实发单。

---

## 币安模拟盘（Demo Mode）

本项目默认接入**币安现货模拟交易**。依据官方文档
[binance-spot-api-docs/demo-mode](https://github.com/binance/binance-spot-api-docs/blob/master/demo-mode/general-info_CN.md)，
模拟交易除**主机域名**外，与现货 API 完全相同（路径、`/api` 前缀、`X-MBX-APIKEY` 头、HMAC-SHA256 签名、`recvWindow` 均不变）：

| 服务 | 模拟交易（Demo） | 旧测试网 | 正式环境 |
| --- | --- | --- | --- |
| REST | `https://demo-api.binance.com/api` | `https://testnet.binance.vision/api` | `https://api.binance.com/api` |
| WS 行情 | `wss://demo-stream.binance.com/ws` | `wss://testnet.binance.vision/ws` | `wss://stream.binance.com:9443/ws` |

**申请密钥**：登录币安 → Binance 模拟交易 →
[API 密钥管理](https://demo.binance.com/en/my/settings/api-management)

**配置**：

```env
BINANCE_ENABLED=true
BINANCE_ENV=demo          # demo | testnet | live
BINANCE_API_KEY=xxx
BINANCE_API_SECRET=xxx
```

然后在后台「交易所账户」页点「测试连接」，看到类似
`模拟盘连接正常，已读取 2 个非零币种（USDT 5000，USDC 5000）` 即表示打通。

**Demo 与旧 Testnet 的区别**（文档原文要点）：

| | 旧测试网 | 模拟交易（Demo） |
| --- | --- | --- |
| 余额 | 每月重置一次 | 可随时在界面重置 |
| 行情 | 与正式交易所**独立** | 与正式交易所**相似** |
| 功能 | 可能先于正式环境 | 始终与正式环境一致 |

**双通道设计**：交易接口（下单/撤单/查单/余额）走账户环境主机；
公共行情（K 线、Ticker、WS 行情流）走币安公共行情域名 `data-api.binance.vision` / `wss://data-stream.binance.vision`。
这样即使交易主机不可达，看板、K 线与 Agent 决策仍使用真实生产行情正常工作。

**行情双流**：行情侧同时订阅两路公共流，各自独立重连、互不影响。

| 数据流 | 内容 | 频率 | 用途 |
| --- | --- | --- | --- |
| `@kline_1m` | 1 分钟 K 线 | 约 2s 一帧 | 权威数据：K 线落库、技术指标、图表 |
| `@bookTicker` | 最优买卖价 | 约 100ms 一帧 | 秒级价格：顶栏报价、24h 高低、当前 K 线收盘价 |

两路流汇聚到同一推送出口，统一按 **1 秒**节流广播给前端，避免重复推送。
`bookTicker` 取买卖中间价，抖动小于逐笔成交流；它只负责填补两帧 K 线之间的空白，
K 线闭合时始终以 `@kline_1m` 的权威数据为准。

任一路流心跳超时（K 线 30s / 报价 15s）只重连该路，不会牵连另一路；
两路都断且超过有效期后，价格自动回落到最新 K 线收盘价。

**前端秒级刷新（无轮询）**：K 线图与迷你走势图**不做定时轮询**。
首次由 REST 拉全量，之后直接消费已在推送的 `price` 事件，在本地把最新价合并进最后一根 K 线
（同周期更新 `close`/`high`/`low`，跨周期追加新 K 线），并用 lightweight-charts 的 `series.update()`
做增量渲染。因此 1m / 5m / 1h / 4h / 1d **任意周期都是秒级刷新**，无需服务端广播多周期 K 线事件。

断线重连时补拉一次全量修正偏差；若缺口超过一个周期，本地停止推进以免画出错误的中间 K 线。
用户手动缩放或平移图表时不会被刷新重置——只在切换周期/交易对时才 `fitContent()`。

---

## 网络代理

访问境外交易所受阻时，在 `.env` 配置代理，**REST 与 WebSocket 同时生效**：

```env
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
```

- 留空则直连，行为与未配置时完全一致
- 启动时日志会输出 `网络出口：已启用代理 ...` 或 `未配置代理（直连）`
- 连通性探测失败且原因为超时时，错误信息会提示检查网络与代理

---

## 无密钥也能跑通

系统按「真实优先、逐层降级」设计，任何外部依赖不可达时都不会崩溃：

| 能力 | 真实来源 | 降级方案 |
| --- | --- | --- |
| 行情 | 币安 / OKX 公共 REST + WebSocket | 内置**拟真模拟行情**（几何布朗运动，多周期自洽） |
| 大模型 | DeepSeek（OpenAI 兼容协议） | 降级为**纯技术指标策略**，决策记录标记 `degraded: true` 并写入降级原因 |
| 新闻 | CoinDesk / Cointelegraph / Bitcoin Magazine 免费 RSS | 注入**拟真新闻语料**，保证决策链路有新闻输入 |
| 账户余额 | 交易所实时查询 | **虚拟账户**（初始 10,000 USDT + 0.05 BTC，由 dry-run 历史成交推导） |

> 余额快照带 `source` 标记（`virtual` / `exchange`），今日盈亏与回撤只与**同来源**的基线比较，
> 避免切换运行模式时把两种口径的权益混算成虚假亏损而误触发风控熔断。

降级状态在后台「总览看板 → 数据源状态」中实时可见。

---

## 决策链路

一次决策的完整生命周期，全部落 `agent_decisions` 表（JSONB 内嵌快照），后台可逐节点展开复盘：

```
行情快照 → 指标信号 → 新闻上下文 → 组装 Prompt → 模型输出 → 风控裁决 → 下单结果
```

**技术指标**（前后端共用 `packages/shared/src/indicators`，保证图表与信号口径一致）：

- 趋势：SMA5 / SMA10 / SMA20 / SMA60、EMA12 / EMA26
- 动量：RSI(14)、MACD(12,26,9)
- 波动：布林带(20,2)、ATR(14)
- 量能：最新量 / 20 周期均量

信号按权重合成 `-1 ~ +1` 的综合倾向，与行情、新闻一并交给模型裁决。模型输出经 **zod schema 强校验**（`action` / `confidence` / `reason` / `riskNotes`），解析失败或超时即降级。

---

## 风控

**所有下单（Agent 自动单 + 后台手动单）统一经过 `RiskService` 校验，无法绕过：**

| 规则 | 字段 |
| --- | --- |
| 单笔最大金额 | `maxOrderAmount` |
| 最小下单间隔（冷却） | `minOrderIntervalSec` |
| 单日最大下单笔数 | `maxDailyOrders` |
| 日亏损上限 | `dailyLossLimit` |
| 最大回撤熔断 | `maxDrawdownPct` |
| 单一标的持仓集中度 | `maxExposurePct` |
| 可用余额校验 | 自动读取 |
| 实盘二次确认 | `LIVE_TRADING_CONFIRM_TOKEN` |

触发即写入 `risk_events` 并阻断下单，同时回写到决策记录的 `riskRejectedBy` 字段。

### 风控的三个关键约束

**1. 单一权威出口**。所有下单都由 `TradingService` 确定价格、按交易所精度取整、执行风控后再发单。
调用方（Agent）最多做一次**咨询性预检**用于快速失败，权威结论以 `TradingService` 返回的为准——
否则上游用快照价、下游用实时价，两次读价之间的漂移会让风控形同虚设。

**2. 阈值 0 不再表示「关闭」**。风控各项原本以 `> 0` 作为启用判据，配置置 0 即等于关闭该规则。
现在所有风控参数在写入与读取时都会被钳制到安全区间（`RISK_LIMITS`），
置 0 会回落到下界而非失效，避免误配置导致裸奔。

**3. 实盘保持手动确认**。Agent **不会**自动携带二次确认 Token，因此实盘模式下自动调度会被跳过。
这不是缺陷而是设计：跳过时会写入一条 `risk_events` 并节流告警（10 分钟一次），
前端风控面板可见，避免「以为在跑其实没跑」且无痕迹。实盘交易需通过后台手动下单。

### 交易精度与过滤器

交易所会按 `stepSize` 校验数量、按 `tickSize` 校验价格、按 `minNotional` 校验名义价值，
任一项不满足都会直接拒单（币安 -1013 / -1111 / -4164）。
`ExchangeAdapter.getSymbolFilters()` 统一提供该能力，按 symbol 缓存 24 小时、按需懒加载，
下单前由 `normalizeOrder()` 完成取整与最小名义价值校验。

### 滑点与手续费建模

`dry_run` 撮合默认按 **5 bps 滑点 + 10 bps 费率**成交（均可配置），
买入向上滑、卖出向下滑。此前按 ticker 精确成交会让回测结果系统性偏乐观。

### 持仓

`PositionService` 由 `trade_fills` 成交明细推导持仓（移动加权平均成本法），
提供净量、均价、已实现/未实现盈亏、累计手续费等指标，通过概览接口 `position` 字段返回。
不单独建持仓表——成交明细已是事实来源，避免与主订单表产生双写一致性问题。

### 失败退避与熔断

Agent 连续失败时按指数退避重试（30s → 60s → 120s …），
达到 5 次进入熔断，冷却 10 分钟后重试；状态通过 `/api/agent/config` 的 `health` 字段暴露。
LLM 不可用时，默认 `degradedAction=hold` 会把决策强制降级为观望，
不让未经验证的兜底策略接管真实资金。

---

## 目录结构

```
AI-trader-btc/
├── docker-compose.yml          PostgreSQL 16 + Redis
├── scripts/init-db.sql         无 Docker 时的数据库初始化
├── packages/shared/            跨端共享：类型 / DTO / 指标纯函数
│   └── src/{types,dto,indicators}
└── apps/
    ├── server/                 Nest.js 后端
    │   └── src/
    │       ├── config/         Joi 环境变量校验
    │       ├── database/       TypeORM 实体、迁移、种子数据
    │       ├── exchanges/      ExchangeAdapter 接口 + 币安/欧意适配器 + 签名
    │       ├── market/         行情 WS、K 线缓冲落库、市场动向聚合、模拟行情源
    │       ├── news/           RSS 抓取去重、关键词打标、降级语料
    │       ├── agent/          信号合成、Prompt 组装、LLM 客户端、决策编排
    │       ├── trading/        订单生命周期、风控守卫、dry-run/实盘路由
    │       ├── account/        余额读取、虚拟账户、快照与今日盈亏
    │       ├── scheduler/      定时任务（行情恢复、新闻、决策、快照、探测）
    │       ├── gateway/        socket.io 实时推送
    │       └── overview/       聚合接口
    └── web/                    Vite + React + antd 响应式前端
        └── src/
            ├── layouts/        MobileLayout（顶价格条 + 底 TabBar）/ AdminLayout（侧栏 + 顶栏）
            ├── components/     KlineChart、DecisionTimeline、OrderPanel、PriceTicker…
            ├── pages/mobile/   钱包首页、交易、订单、Agent
            └── pages/admin/    总览、Agent 配置、决策历史、新闻与市场、订单、账户、风控
```

---

## 接入交易所

### 币安模拟盘（推荐）

1. 前往 https://demo.binance.com/en/my/settings/api-management 创建密钥
2. 后台「交易所账户」页填写 API Key / Secret，环境选「模拟盘」，点击「测试连接」
3. 详见上方「币安模拟盘（Demo Mode）」章节

### 币安旧测试网

1. 前往 https://testnet.binance.vision 申请 API Key
2. 后台「交易所账户」页填写，环境选「测试网」

> 注意：旧测试网的密钥**不能**用于模拟盘，反之亦然，环境选错会返回 `-2015 Invalid API-key`。

### 欧意 OKX

1. 在 OKX 创建 API 时**勾选 Demo trading**
2. 填写 API Key / Secret / **Passphrase**（欧意必填）

密钥使用 `APP_MASTER_KEY`（AES-256-GCM）**加密落库**，接口只返回掩码，前端无法查看明文。

### 接入大模型

```env
LLM_ENABLED=true
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxxxxx
LLM_MODEL=deepseek-chat
```

支持任何 OpenAI 兼容协议的服务（DeepSeek / 通义 / OpenAI 等），改 `LLM_BASE_URL` 即可。

---

## 常用命令

```bash
pnpm dev                 # 前后端并行开发
pnpm build               # 全量构建
pnpm typecheck           # 全量类型检查
pnpm start               # 生产模式启动后端

pnpm -F @ai-trader/server seed                  # 写入种子数据
pnpm -F @ai-trader/server migration:run         # 执行迁移
pnpm -F @ai-trader/server migration:generate -- src/database/migrations/xxx  # 生成迁移
```

---

## 主要接口

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 登录获取 JWT | 否 |
| GET | `/api/overview` | 聚合概览（行情/余额/动向/订单/决策/新闻） | 否 |
| GET | `/api/market/candles` | K 线 | 否 |
| GET | `/api/market/pulse` | 今日市场动向 | 否 |
| GET | `/api/orders` | 订单分页列表 | 否 |
| POST | `/api/orders` | 手动下单（走风控） | 是 |
| POST | `/api/orders/:id/cancel` | 撤单 | 是 |
| GET | `/api/agent/config` | Agent 配置与运行状态 | 否 |
| PATCH | `/api/agent/config` | 更新配置 | 是 |
| POST | `/api/agent/run` | 手动触发一次决策 | 是 |
| GET | `/api/agent/decisions` | 决策列表 | 否 |
| GET | `/api/agent/decisions/:id` | 决策链条详情（含 Prompt 与模型原始输出） | 否 |
| GET | `/api/news` | 新闻流 | 否 |
| GET | `/api/risk/events` | 风控事件 | 否 |
| GET | `/api/accounts` | 交易所账户（密钥掩码） | 是 |
| POST | `/api/accounts/:exchange/test` | 连通性探测 | 是 |

WebSocket 事件（`/realtime` 命名空间，`realtime` 事件名）：

```ts
{ type: 'price' | 'order' | 'decision' | 'risk' | 'news', payload: ..., ts: number }
```

---

## 注意事项

- **生产环境请将 `DB_SYNCHRONIZE` 设为 `false`**，统一走 TypeORM migration
- `.env` 已在 `.gitignore` 中，请勿提交密钥
- 修改 `APP_MASTER_KEY` 会导致已加密的交易所密钥无法解密，需重新录入
- 切实盘前请务必在测试网充分验证策略，并设置合理的风控阈值
