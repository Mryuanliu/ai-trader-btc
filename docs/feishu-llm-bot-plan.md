# 飞书对话式交易助手 + LLM 能力层加强 —— 开发计划

> 状态:已实现(2026-09-29,单测 55/55 绿,tsc/build 通过;上线前置见文末) | 产出会话:2026-09-29 | 关联:`docs/user-auth-isolation-plan.md`(用户隔离,解耦)、`feishu-trade-push`(已上线的推送链路)

## 1. 背景与目标

推送链路(开仓成交/平仓结束/整轮了结)已上线。本期把机器人能力补齐:

1. **对话查询**:群里 @ 机器人问「今天收益怎样」「这个月赚了多少」「当前持仓」「策略状态」等,LLM 调用行内数据服务作答。
2. **受控写操作**:启停策略、一键平篮子——必须走「确认卡 → 回复确认」两步,不允许对话直接下单。
3. **LLM 能力层加强**:现有 `LlmClient` 只有 `analyzeContext()` 单发 JSON 输出(无多轮、无工具调用、无重试、无 token 预算),本次建成通用 `LlmChatService`,飞书机器人是第一个消费方,Web 端聊天将来复用。

参考代码:`/Users/apple/Desktop/muse-studio/backend/src/feishu/`(机器人管道:长连接收消息、去重、串行队列、会话绑定、卡片回复;它的 coding-agent 运行时不要照搬)。

## 2. 已锁定设计决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 接收方式 | `Lark.WSClient` 长连接收 `im.message.receive_v1`,**无需公网回调**;ws 直连 open.feishu.cn,不受本机币安代理影响 |
| 2 | 发送/回复 | 统一走已上线的裸 axios `FeishuService`(proxy:false),新增 `replyMessage()` 一个 REST;不再引 SDK 发送路径 |
| 3 | LLM 层 | 新建 `agent/llm-chat.service.ts`(chatOnce/chatWithTools/runToolLoop),`analyzeContext` 原链路不动,共享底层 OpenAI client |
| 4 | 写操作 | `stop_strategy/start_strategy/close_basket` 三个,经 `shouldIntercept` hook 拦截 → pendingAction(TTL 60s)→ 确认卡 → 用户回「确认」执行 /「取消」作废;LLM 循环内**永不直接执行** |
| 5 | 会话 | DB 持久化多轮(最近 20 条 + ~8k token 截断),`/new` 重置;`feishu_message_receipts` 按 messageId 唯一索引幂等去重 |
| 6 | 权限 | `FEISHU_BOT_ALLOWED_CHATS` 白名单(默认 = FEISHU_CHAT_ID),名单外群完全不响应;写操作仅白名单群 |
| 7 | 开关 | `FEISHU_BOT_ENABLED` 默认 false,与 `FEISHU_PUSH_ENABLED` 独立 |
| 8 | 口径 | system prompt 内置「口径知识表」:净盈亏=已扣双边费、止盈按标记价、环境标注(demo/live),防机器人与网页数字对不上 |
| 9 | 隔离 | 工具执行器暂全是 admin 全局数据;与用户隔离规划解耦,后续给执行器加 userId 维度即可 |
| 10 | 不引 agent 框架 | Vercel AI SDK 6 / OpenAI Agents SDK / LangGraph / Claude Agent SDK 均不采用(调研结论:自研 runToolLoop ~200 行即最小闭环;Claude SDK 绑模型+spawn 子进程,Nest 服务不适配;LangGraph 状态图用不上)。MCP 只加官方轻量依赖 `@modelcontextprotocol/sdk`;Skills 对齐 agentskills.io 开放标准自研 |
| 11 | Skills 形态 | `agent/skills/<name>/SKILL.md`(frontmatter name/description + 正文指令),渐进披露:清单进 system prompt → `load_skill(name)` 元工具读全文 → 只读不执行其中脚本;可复用社区现成 skill |
| 12 | MCP 接入 | env `MCP_SERVERS`(JSON):http(StreamableHTTP)/stdio 两种 transport;工具名 `<server>__<tool>` 防冲突;连接失败仅记日志不阻塞启动;**MCP 工具默认按写操作对待,全部走确认流** |

## 3. 架构与消息流

```
飞书群 @机器人
  → WSClient 长连接事件 (im.message.receive_v1)
  → receipt 去重 (唯一索引冲突即丢)
  → 白名单过滤 / bot 自身消息过滤
  → 按 chat 串行队列 (Map<key, Promise>)
  → 「确认/取消」裸词? ──是──→ ConfirmationStore 执行/作废,不进 LLM
  → /new? ──是──→ 清会话,回提示
  → 否: 秒回 ack 卡 → LlmChatService.runToolLoop
       (system prompt + 会话历史 + 新消息)
       → chatWithTools → tool_calls → 执行只读工具回喂 → ... (≤6 轮)
       → 写工具命中 shouldIntercept → 存 pending + 回确认卡
  → 最终 markdown 卡 reply
```

## 4. 阶段清单

### Phase A 收消息链路(feishu/)

- [x] `feishu/entities/feishu-message-receipt.entity.ts`:`messageId`(unique)+ `tenantKey` + `createdAt`
- [x] `feishu/entities/feishu-chat-session.entity.ts`:`tenantKey+chatId`(unique)、`openId`、`messages: jsonb`、`updatedAt`
- [x] `database/migrations/1700000022000-FeishuBot.ts`:建两张表(含回滚)
- [x] `feishu/feishu.service.ts`:新增 `replyMessage(messageId, markdown)`(`POST /im/v1/messages/{id}/reply`,复用卡片组装与 28KB 截断)
- [x] `feishu/feishu-bot.service.ts`(新):`OnApplicationBootstrap` 起 WSClient + EventDispatcher(可选 encryptKey/verificationToken);去重;队列;白名单;ack;调 feishu-agent
- [x] env:`FEISHU_BOT_ENABLED`、`FEISHU_BOT_ALLOWED_CHATS`、`FEISHU_ENCRYPT_KEY?`、`FEISHU_VERIFICATION_TOKEN?`(Joi + AppEnv + .env.example)
- [x] `feishu.module.ts` 注册 providers + `TypeOrmModule.forFeature([两实体])`

### Phase B LLM 能力层(agent/)

- [x] `agent/llm-chat.service.ts`(新),核心签名:
  ```ts
  chatOnce(messages, opts?): Promise<LlmChatResult>            // 单轮纯文本
  chatWithTools(messages, tools, opts?): Promise<AssistantMsg> // content 或 tool_calls
  runToolLoop(params: {
    userText: string;
    history: ChatMessage[];          // 已截断的会话历史
    tools: ToolRegistry;             // name → {def, exec}
    hooks?: {
      onToolCall?(name, args, ms, resultBytes): void;   // 可观测
      shouldIntercept?(name, args): Promise<string|null>; // 写工具拦截,返回给模型的 tool 结果
      onFinal?(text): void;
    };
    maxRounds?: number;              // 默认 LLM_MAX_TOOL_ROUNDS(6)
  }): Promise<{ text: string; rounds: number; usage: TokenUsage | null }>
  ```
  - 重试:429/5xx/网络错 → 指数退避 2 次(500ms/2s);硬失败沿用 60s cooldown
  - 超时:`LLM_CHAT_TIMEOUT_MS`(默认 45000),与 analyzeContext 的 30s 分离
  - 历史窗口:~8k token 估算截断(保 system + 最近 N 条,从最老丢)
  - 循环终止:无 tool_calls 即收敛;达 maxRounds 用兜底话术「这个问题我需要更多步骤,请换个问法」
- [x] `agent/llm-tools.ts`(新):`ToolDefinition`(OpenAI function schema)、`ToolExecutor`、`ToolRegistry`;zod 参数校验——非法参数不抛异常,把结构化错误当 tool 结果回喂让模型自修正(最多浪费 1 轮)
- [x] `agent/prompts.ts`(新):`buildBotSystemPrompt(ctx: { now, env, runMode })`——身份、工具规则、口径知识表、时间注入、「数据以工具为准/禁止编造/非投资建议」
- [x] env:`LLM_CHAT_MODEL`(默认 deepseek-chat)、`LLM_CHAT_TIMEOUT_MS`、`LLM_MAX_TOOL_ROUNDS`
- [x] 可观测:Logger 输出每次提问的工具调用链(名称/参数摘要/耗时/结果字节)+ 总 token
- [x] 基座实测已过(2026-09-29 probe):DeepSeek 端点 tools 可用;别名 deepseek-chat 被解析为 `deepseek-flash`,`reasoning_content` 可能消失——解析/日志不依赖该字段,模型名以响应 `model` 为准

### Phase B3 MCP + Skills(轻挂接,不引框架)

- [x] 依赖:`@modelcontextprotocol/sdk`(官方 TS SDK,轻量)
- [x] `agent/mcp-tool-source.ts`(新):解析 env `MCP_SERVERS`(JSON 数组 `[{name, transport:'http'|'stdio', url|command/args, enabled}]`,默认 `[]`);逐个 connect→listTools→注册进 ToolRegistry(命名 `<server>__<tool>`);callTool 执行;失败仅记日志不阻塞启动
- [x] MCP 工具安全默认:来源为 MCP 的工具一律视为写操作,走 `shouldIntercept` 确认流
- [x] `agent/skills/` 目录 + `agent/skill-loader.ts`(新):扫描 `*/SKILL.md`,解析 frontmatter(name/description);清单注入 system prompt(发现);元工具 `load_skill(name)` 读全文作为 tool 结果回喂(激活);只读文件,不执行脚本
- [x] 示例技能:`agent/skills/pnl-report/SKILL.md`(周报/月报固定体例:先调工具取数,再按模板输出)
- [x] env:`MCP_SERVERS`(Joi + AppEnv + .env.example)

### Phase B2 交易工具与飞书接入(feishu/)

- [x] `feishu/tools/trading-tools.service.ts`(新),9 个只读工具薄映射:
  | 工具 | 底层 | 说明 |
  |---|---|---|
  | get_pnl_summary(period, from?, to?) | `IncomeService.summary` | 已实现/手续费/资金费,交易所权威口径;period=today/7d/30d/this_month/custom |
  | get_daily_pnl(days) | `LotService.realizedPnlByDay` | 按日已实现(净值口径) |
  | get_account_overview(symbol?) | `OverviewService.build` | 余额+持仓+盈亏总览 |
  | list_open_positions() | `FuturesPositionService.listPositions` | 含标记价/最新价 |
  | list_recent_baskets(limit) | `BasketService.listRecent` | 篮子净口径(含浮动) |
  | list_recent_orders(limit) | `FuturesTradingService.list` | 近期订单 |
  | get_market_price(symbol) | `MarketService.getTicker/getMarketPulse` | 行情 |
  | get_strategy_status() | `StrategyRunner.list/getStatus` + `FuturesConfigService.getRunningIntent` | 运行状态 |
  | get_news_latest(limit) | News 查询 | 快讯 |
- [x] 写工具 3 个(schema 定义进 trading-tools,执行权在 confirmation):`stop_strategy(instanceId?)`、`start_strategy(name?, symbol?)`(默认参数)、`close_basket()`
- [x] `feishu/confirmation.store.ts`(新):`Map<chatId, { actions: PendingAction[], expiresAt }>`,TTL 60s;confirm 时逐条执行并汇总结果卡
- [x] `feishu/feishu-agent.service.ts`(新):会话读写 DB、拼 history,调 `runToolLoop`(挂 shouldIntercept),本身不实现循环

### Phase C 打磨

- [x] 回复统一 markdown 卡;失败兜底「处理失败:{原因}」
- [x] system prompt 口径表与实际面板口径复核一遍(净/毛、标记价、环境)
- [x] `.env.example` 完整注释(长连接开启步骤、事件订阅、权限清单)

## 5. 影响文件清单

新增:`feishu/`{feishu-bot, feishu-agent, confirmation.store, tools/trading-tools, entities/×2}、`agent/`{llm-chat.service, llm-tools, prompts, mcp-tool-source, skill-loader, skills/×n}、`database/migrations/1700000022000-FeishuBot.ts`、spec 文件若干
修改:`feishu.service.ts`(replyMessage)、`feishu.module.ts`、`agent.module.ts`(注册新 providers)、`config/configuration.ts`、`.env.example`、`apps/server/package.json`(+`@modelcontextprotocol/sdk`)

## 6. 测试计划

- 单测(vitest,mock OpenAI/服务):
  - receipt 去重(同 messageId 并发只处理一次)、chat 队列串行
  - `runToolLoop`:两轮收敛、maxRounds 上限、429 退避重试、历史截断、非法参数回喂自修正
  - 确认流:写工具被拦截不落执行、confirm 执行、60s 过期作废、「取消」作废
  - 工具映射:每个工具参数→底层服务调用(mock 断言)
- 集成:白名单外群完全不响应;`FEISHU_BOT_ENABLED=false` 时不建 WS 连接
- 手动:飞书后台开「长连接」+ 订阅 `im.message.receive_v1` + `im:message` 权限 → 群发「今天收益怎样」「这个月赚了多少」「当前持仓」「停掉策略」(验证确认卡全链路)
- 全量:`tsc --noEmit`、`nest build`、vitest;改动记 `.codebuddy/memory/`

## 7. 风险与注意

- **长连接单实例互斥**:同一 APP_ID 多处跑 WSClient 会抢事件——若 muse-studio 用同一应用,需为交易机器人单独建应用(落地前确认)
- 飞书「企业自建应用」需发布版本 + 开通发消息/收事件权限,群里 @ 机器人才有事件(部分版本不 @ 不推送,手动清单里注明)
- LLM 幻觉:数字一律来自工具;system prompt 明令禁止口算/估算收益率
- 提示注入:用户消息可能诱导调用写工具——写工具已被 confirm 流程兜住;白名单群外完全静默
- demo/testnet/live 环境:回答里必须带环境标注,避免跨环境数字对比误解
- deepseek 长对话 token 成本:每问 ~2-6k token,单人自用可忽略

## 8. 排期

约 5.5 人日:A 收消息 1 / B LLM 能力层 1.5 / B3 MCP+Skills 1 / B2 工具+接入 1 / C 打磨+手动验证 1。
建议顺序:B(可单测闭环)→ B3 → A → B2 → C;每阶段完成即可独立验证。

## 7. 上线步骤(2026-09-29 实现完成后补)
1. 飞书开放平台 → 应用 → 「事件与回调」订阅方式选 **使用长连接接收事件**;添加事件 `im.message.receive_v1`。
2. 「权限管理」开通 `im:message.group_at_msg`(群内 @ 机器人消息)或 `im:message`;发布新版本并审核通过。
3. `.env`:`FEISHU_BOT_ENABLED=true`(白名单 `FEISHU_BOT_ALLOWED_CHATS` 留空则默认只响应推送群);确认 `LLM_API_KEY` 已配。
4. 重启服务(`touch apps/server/src/main.ts` 触发 watch),日志出现「飞书对话机器人长连接已建立」即成功。
5. 群里 @ 机器人试:「今天收益怎样」「当前持仓」「停掉策略」(后者应回确认卡,60s 内回「确认」执行)。
