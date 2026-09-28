# 开发计划：用户注册 + 用户级数据/执行隔离

> 状态：待排期落地（本文档只做规划，不含实现）
> 创建：2026-09-29
> 决策基线：注册用邮箱验证码；**邮件先走可替换的 stub 传输**；**每个用户绑定自己的币安合约密钥**；两个兜底策略作为全局目录对所有登录用户可见；现有 env 配置与历史数据全部归属 `admin`。

---

## 1. 背景与目标

### 现状
- 认证：单一 `admin` 用户（`ADMIN_USERNAME/PASSWORD` 首启自动建），JWT 登录，`users` 表只有 `username/passwordHash/role`。
- 交易：整个引擎只用 **env 里配置的单一币安（demo）账户**；`exchange_accounts` 按 `exchange` 全局唯一；`ExchangeRegistry` 每个交易所码只缓存一个适配器。
- 运行器：`StrategyRunner` 是全局单例，`instances` 按 `instanceId = 策略名:交易对` 唯一；`tick()` 用全局账户。
- 数据：`strategy_instances / baskets / position_lots / orders / trade_fills / exchange_accounts / futures_agent_configs / exchange_income` **均无 userId**。

### 目标
1. 新增邮箱验证码注册（`MailerService` 抽象，先 stub，日后换真实 SMTP 只改实现）。
2. 全链路用户级隔离：数据带 `userId`，交易执行按用户路由到各自密钥。
3. 两个兜底策略（`martingale_grid`、`trend_following`）作为全局只读目录，所有用户可见并可各自启动。
4. 现有 env 配置与所有历史数据归属 `admin`。

### 核心矛盾（必须理解）
合约是「每账户净持仓」模型——两个用户若共用一个账户在同标的跑策略会互相抢仓。因此**每用户绑定自己的密钥**从根上解决该问题：各自独立账户、独立持仓。行情则是公共数据，保持全局单份价流。

---

## 2. 关键设计决策（已锁定）

| 决策 | 取舍 | 理由 |
|---|---|---|
| 行情公共、账户私有 | `MarketService` WS 价流/K线保持全局；仅下单/持仓/余额/保证金/配置/篮子/仓位单按 userId | 行情人人相同，账户各不同 |
| `instanceId = userId:策略名:交易对` | 改唯一索引与恢复逻辑 | 避免跨用户撞索引 + 解决净持仓抢仓 |
| runner 仍单进程单例 | 每个实例携带 userId，`tick()` 逐实例用其账户 | 改动可控，无需多进程 |
| 新用户默认 `dry_run` | admin 保留 env 真实环境 | 安全兜底 |
| admin = 普通用户 + env 配置 + 全部历史数据 | 额外给 admin-only 用户列表接口 | 不做完整后台 |
| 登录标识 email 或 username | `users` 加 `email`（唯一、可空）；新用户 username 存 email | 兼容老 admin |
| 验证码存储 | 新表 `email_verifications`（存 codeHash，TTL 10 分钟，限频 60s，最多 5 次尝试） | 无 Redis 依赖，落库可审计 |

---

## 3. 分阶段落地

> 建议严格按阶段顺序推进，**每阶段跑 `typecheck + test + build` 全绿再进下一阶段**。Phase 3/4 是串号风险最高的核心区。

### Phase 1 — 数据模型与用户上下文
- [ ] `user.entity.ts`：加 `email?: string`（`@Index({unique:true})`, nullable）。
- [ ] 以下实体统一加 `userId: string`（uuid/varchar + 索引 `IDX_*_user`）：
  - `strategy-instance.entity.ts`（唯一索引改 `['userId','instanceId']`）
  - `basket.entity.ts`、`position-lot.entity.ts`、`order.entity.ts`、`trade-fill.entity.ts`
  - `exchange-account.entity.ts`（唯一索引 `['exchange']` → `['userId','exchange']`）
  - `futures-agent-config.entity.ts`（`key` 由固定 `'default'` 改为按 userId，或新增 userId 列并唯一）
  - `exchange-income.entity.ts`
- [ ] 新增 `email-verification.entity.ts`：`id, email, codeHash, purpose('register'), expiresAt, attempts, lastSentAt, consumedAt, createdAt`。
- [ ] 新增 `common/user-context.ts`：`AuthUser { userId; role; username }` + 取 `req.user.userId` 的辅助（JwtStrategy 已注入）。

### Phase 2 — 注册 + 邮箱验证码(stub) + 登录
- [ ] 新增 `mail/mailer.module.ts` + `mail/mailer.service.ts`：
  - `sendVerificationCode(email, code)`；实现 `StubMailSender`（`Logger.log` 打印；`MAIL_DEV_RETURN_CODE=true` 时接口回传 code 便于本地自测）。接口化，日后加 `SmtpMailSender` 仅换绑定。
- [ ] `auth.service.ts` 扩展：
  - `requestRegisterCode(email)`：查重 → 限频（`lastSentAt` 60s 内拒绝）→ 生成 6 位码存 `codeHash`（sha256/bcrypt），TTL 10 分钟 → `mailer.send`。
  - `register(email, code, password)`：校验未过期/未消费、`attempts<5`、比对码 → 建 `users`(role `'user'`, username=email, passwordHash) → 建默认 `futures_agent_config`(mode=dry_run) → 消费码 → 返回 JWT（自动登录）。
  - `login(identifier, password)`：`where email OR username`。
- [ ] `auth.controller.ts`：加 `POST /auth/register/send-code`、`POST /auth/register`（公开、无 guard）；`profile` 返回加 `email/role`。
- [ ] `auth.module.ts`：`imports` 加 `MailerModule`、`TypeOrmModule.forFeature([EmailVerificationEntity])`。

### Phase 3 — 查询侧用户隔离（读）
控制器把 `req.user.userId` 传入服务，服务查询一律 `where { userId }`：
- [ ] `basket.service.ts`、`lot.service.ts`、`income.service.ts`、`position.service.ts`：列表/汇总加 userId 过滤；写入路径落 userId。
- [ ] `overview.controller.ts` + 相关 service：总览/近期篮子/收益日历按 userId 聚合。
- [ ] `exchanges/accounts.controller.ts`：账户列表/编辑按 userId。
- [ ] `futures.controller.ts`：`positions`/`config`/`margin` 按 userId。
- [ ] `strategy.controller.ts`：`status`/`performance`/`leaderboard` 按 userId；**`GET /strategy`（hub 目录）保持全局**，所有用户可见两个策略。

### Phase 4 — 执行侧用户隔离（每用户密钥 + runner）
- [ ] `exchange-account.service.ts`：`getCredentials(code, userId)`、`list(userId)`、`upsert(userId, input)`、`findOne(code, userId)`、`updateProbe(code, userId)`；`seedFromEnv()` 把 env 密钥写入 **admin 用户**名下。
- [ ] `exchange-registry.service.ts`：`get(code, userId)` 缓存键 `${code}:${userId}`；`invalidate(code?, userId?)`；`getPublic()` 保持全局。
- [ ] `futures-config.service.ts`：按 userId 读写各自 config 行（非 admin 默认 dry_run）。
- [ ] `futures-trading.service.ts`、`futures-position.service.ts`：所有方法加 userId，内部 `registry.get('binance-futures', userId)`。
- [ ] `strategy-runner.service.ts`：
  - `instances` 值加 userId；`start/startInstance(..., userId)`；`instanceId = userId:name:symbol`。
  - `tick()` 逐实例用其 userId 调 positions/trading/config；`buildContextFor(userId, inst)`。
  - `resumeIfShould()` 按 `row.userId` 恢复。
- [ ] `strategy-instance.service.ts`：`instanceIdOf(userId, name, symbol)`；`markRunning/listShouldRun/listAll` 带 userId。
- [ ] 密钥绑定接口：`POST /futures/bind-key`（用户提交自己 Binance Futures apiKey/secret/env）→ `upsert(userId,...)` + `invalidate(code,userId)` + `probe`。

### Phase 5 — 前端
- [ ] `store/auth.ts`：加 `role`、`email`；`setAuth` 扩展。
- [ ] 新增 `pages/auth/Register.tsx`：邮箱 → 发送验证码 → 填验证码 + 设密码 → 注册即登录；公开路由。
- [ ] `pages/auth/Login.tsx`：标识字段改「邮箱或用户名」，加「注册」入口。
- [ ] `api/client.ts` / `hooks.ts`：加 `register` / `sendCode` / `bindExchangeKey`。
- [ ] 新增/复用「交易所密钥」设置页（用户填自己的 Binance 合约 Key + 环境）。
- [ ] `router.tsx`：`/register` 公开；受保护路由不变。

### Phase 6 — 迁移 / 回填 / 验证
- [ ] 迁移：`database/migrations/` 新增一份（加 `userId`/`email` 列、改唯一索引、建 `email_verifications`）。dev 可靠 `DB_SYNCHRONIZE=true`，prod 走 migration。
- [ ] 回填脚本 `database/backfill-user-id.ts`（仿 `backfill-real-fees.ts`：默认 dry-run + `--apply`，幂等）：取/建 admin 用户 → 把所有历史业务表 `userId` 置为 admin.id；`strategy_instances.instanceId` 重写为 `adminId:旧值`。
- [ ] 验证：`shared build`、`server/web typecheck`、`server test`（补：注册/校验、registry 按用户缓存、runner 多用户实例隔离单测）、`server build`。
- [ ] 改动记入 `.codebuddy/memory/`。

---

## 4. 影响文件清单

**实体（10）**：user / strategy-instance / basket / position-lot / order / trade-fill / exchange-account / futures-agent-config / exchange-income + 新 email-verification

**认证（4）**：auth.service / auth.controller / auth.module + 新 mail/*

**执行（8）**：exchange-account.service / exchange-registry.service / futures-config.service / futures-trading.service / futures-position.service / strategy-runner.service / strategy-instance.service / strategy.controller

**读侧（多）**：basket / lot / income / position / overview / accounts / futures 各 service + controller

**前端（6+）**：store/auth、Login、新 Register、新密钥绑定页、api/client + hooks、router

**脚本（2）**：migration + backfill-user-id

---

## 5. 风险与注意事项

- **串号风险最高**：Phase 3/4 任何一处 userId 漏传都会导致用户数据互相可见/互相下单。要求：service 方法签名强制 `userId` 必填（不给默认值），编译期暴露遗漏。
- **合约适配器缓存**：改 `ExchangeRegistry` 缓存键后，密钥更新务必 `invalidate(code, userId)`，否则旧适配器带旧密钥继续用。
- **桩邮件不可达**：生产上线前必须替换真实 SMTP/邮件 API（`MailerService` 已抽象，仅换实现 + 加 env）。
- **runner 恢复逻辑**：`instanceId` 格式变更后，历史实例行须由回填脚本同步重写，否则重启恢复会命中旧键。
- **密钥安全**：用户密钥沿用现有 `APP_MASTER_KEY` 加解密落库、接口只回掩码；提示用户密钥权限（建议只开合约交易、关提现）。
- **回归重点**：admin 全流程（登录/启动策略/下单/盈亏/回填后的历史数据）必须与改造前一致。

---

## 6. 建议排期

| 阶段 | 预估 | 里程碑 |
|---|---|---|
| Phase 1 | 0.5d | 实体/迁移就绪，admin 不受影响 |
| Phase 2 | 1d | 能注册、能登录（stub 邮件） |
| Phase 3 | 1d | 读侧隔离，前端各页按用户显示 |
| Phase 4 | 2d | 执行隔离 + 密钥绑定（核心，最重） |
| Phase 5 | 1d | 前端注册/登录/密钥页 |
| Phase 6 | 1d | 回填 + 全量验证 |

合计约 6.5 人日。可先做 Phase 1→2 让注册登录闭环跑通（admin 不受影响），再择期攻 Phase 3/4 的执行隔离。
