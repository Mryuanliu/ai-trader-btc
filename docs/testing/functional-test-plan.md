# AI-trader-btc 功能测试计划（按菜单栏 case by case）

- 测试日期：2026-10-04
- 测试方式：浏览器实跑（前端 http://localhost:5173 → 后端 http://localhost:3001）+ 代码走查交叉验证
- 测试账号：admin（默认口令，登录页 placeholder 所示）
- 问题记录落盘：`docs/testing/functional-test-issues-2026-10-04.md`（只记录不修复）

## 测试范围与菜单映射

| 模块 | 路由 | 后端依赖 |
|---|---|---|
| 登录与鉴权 | /login、AuthGate、ProtectedRoute | POST /api/auth/login、GET /api/auth/profile |
| 全局框架 | 侧边栏/顶栏/WS | GET /api/overview、socket.io |
| 总览看板 | /admin | /api/overview、/api/market/candles、/api/market/pulse |
| 策略管理 | /admin/strategy、/admin/strategy/:name | /api/strategy、/api/strategy/start|stop|status|leaderboard|close-basket |
| 上架治理 | /admin/strategy/governance | POST /api/strategy/:name/enabled（闸门） |
| 回测台 | /admin/backtest | POST /api/backtest/run|research|sweep、GET/DELETE /api/backtest/runs |
| AI 行情 | /admin/ai-market | GET /api/ai/market（60s 缓存 + force） |
| 合约面板 | /admin/futures | /api/futures/config|positions|margin|order、/api/lots |
| 新闻与市场 | /admin/news | /api/news、/api/news/refresh、/api/news/calendar |
| 交易所账户 | /admin/accounts | /api/accounts、PATCH /api/accounts/:code、POST /api/accounts/:code/test |
| 移动视图 | /m（窄屏） | 复用上述接口 |

## Case 清单

### A. 登录与鉴权
- AUTH-01 未登录访问 /admin → 应重定向 /login（或弹强制登录框）
- AUTH-02 错误密码登录 → 提示错误、不产生 token
- AUTH-03 正确登录 → success 提示、跳转 /admin、token 持久化
- AUTH-04 已登录访问 /login → 自动回后台首页
- AUTH-05 顶栏「退出」→ 清 token、回登录态
- AUTH-06 401 处理：token 失效后请求应触发登出

### B. 全局框架
- NAV-01 8 个菜单逐一点击：路由正确、选中态正确（详情页高亮父级「策略管理」）
- NAV-02 顶栏 BTC 价格实时刷新（WS 口径）、24h 涨跌幅红绿正确
- NAV-03 顶栏徽标：环境(dry_run/testnet/live)、实时/模拟行情、大模型在线、WS 连接状态与实际一致
- NAV-04 「刷新」按钮 → 聚合数据重取、图标 spin
- NAV-05 「合约 运行中/已停止」Badge 与 /api/strategy/status 一致
- NAV-06 「切换到移动视图」按钮行为（宽屏下 /m 应被重定向回 /admin —— 验证代码走查疑点）

### C. 总览看板
- OVR-01 四个指标卡：价格/账户总估值/今日盈亏/市场情绪，数值与口径提示（InfoHint hover）
- OVR-02 今日盈亏 "--" 降级逻辑（无成交无持仓时不得显示 0）
- OVR-03 K线图：周期切换（1m~1d）后仍渲染、末根随 WS 价格推进
- OVR-04 参考价条：REST 校验价与实时价偏差展示
- OVR-05 市场动向卡：4 项 MiniStat + 关键词热度条；无数据时空态
- OVR-06 数据源状态列表：ok/降级标识与 message
- OVR-07 PnL 日历组件渲染与月份切换
- OVR-08 近期篮子表：行展开层明细、盈亏口径（已实现/含浮动）、空态文案

### D. 策略管理（列表 + 详情）
- STR-01 策略卡片列表：4 个策略包（donchian-breakout / martingale-grid / mean-reversion / trend-following）label、name、description 齐全
- STR-02 「参数配置」弹窗：按 paramSchema 动态渲染 number/boolean/enum 控件、默认值回填、运行币种必填
- STR-03 「启动」：dry_run 下直接启动成功；已有实例运行时改弹配置窗（多实例语义）
- STR-04 未平仓拦截：存在 blockingLots 时弹「接管并启动」确认框并列出仓位明细
- STR-05 「停止策略」→ success 提示、状态 Tag 变「未运行」
- STR-06 「一键平仓」二次确认文案与执行结果 message
- STR-07 卡片「详情」跳转 /admin/strategy/:name；「回测」跳转 /admin/backtest?strategy=xxx 且策略下拉预选
- STR-08 详情页-DSR 闸门徽标：pass/overfit/未测 三态渲染正确
- STR-09 详情页-未运行时显示空态引导；运行时显示运行状态卡（层数/挂单/心跳/等待中/最近动作）
- STR-10 详情页-心跳：>30s 应变红提示"策略可能卡死"
- STR-11 详情页-止盈/止损进度条：净收益/币安毛浮盈/判定价口径标注
- STR-12 详情页-「当前参数」只读展示 defaultParams
- STR-13 详情页-绩效卡（LeaderboardCard）：窗口切换 7d/30d/all、空态文案（noDataEver 分支 vs "该窗口内没有已了结的篮子"）
- STR-14 访问不存在的策略名 → 「未找到策略」空态
- STR-15 live 模式启动应弹真实资金二次确认（若当前为 dry_run 仅做代码走查确认）

### E. 上架治理
- GOV-01 全量列表（含未上架）：enabled 状态 Tag、闸门快照（达标放行/人工放行/未记录）
- GOV-02 上架开关：闸门达标 → 直接上架 success
- GOV-03 上架被拦：弹「闸门未达」Modal，三判据（DSR≥0.5 / OOS Sharpe>0 / OOS 回撤<10%）红绿标注与 reasons 列表
- GOV-04 理由为空 → 「仍要上架（留痕）」按钮禁用；填理由强推 → 留痕成功、列表刷新显示"人工放行"+理由
- GOV-05 下架：确认框文案、执行后状态变化
- GOV-06 「刷新」按钮重取全量列表
- GOV-07 闸门拦截时不得写盘（gated 返回不触发列表 invalidate）

### F. 回测台
- BKT-01 表单：策略下拉、周期、区间（必填校验：不选区间点运行 → 错误提示）
- BKT-02 深链 ?strategy=xxx 预选策略
- BKT-03 单次回测：运行成功 → KPI 8 卡、诚实性 Alert（跑赢/跑输）、净值曲线、逐笔成交分页
- BKT-04 非法 JSON 参数 → 前端报「策略参数 不是合法 JSON」
- BKT-05 稳健性：walk-forward + DSR 结果面板（verdict pass/overfit）、OOS 拼接净值、分段表、CPCV 分布图
- BKT-06 双模式对照：参数名为空校验、TRUE/FALSE 并排表与验收判据
- BKT-07 参数扫描：网格必填、结果表高亮最优行、DSR 列红绿
- BTK-08 历史列表：类型 Tag、指标列 "--" 降级、回看三种 kind 的渲染分支
- BKT-09 删除一次运行 → 列表刷新
- BKT-10 错误分支：数据不足区间 → 后端错误 message 透出

### G. AI 行情
- AIM-01 行情条四值：价格/24h/ATR14/MA30偏离
- AIM-02 市场状态、置信度、激进度、新闻情绪条、持仓视角、参考新闻数
- AIM-03 AI 点评文本；模型不可用时 Alert「AI 分析不可用」+ 本地指标仍显示
- AIM-04 「重新分析」→ 绕缓存、数据更新、按钮 loading
- AIM-05 推理过程 Collapse 展开

### H. 合约面板
- FUT-01 链路开关（enabled Switch）→ PATCH config 生效、Tag 联动
- FUT-02 保证金/杠杆/模式三卡与后端一致；走查疑点：指标区声明 4 列只放 3 卡（布局）
- FUT-03 持仓表：标记价/最新价/强平价/距强平红标（<15%）；无持仓空态
- FUT-04 平仓按钮：无本地 Lot 的行禁用并 Tooltip 引导；有 Lot → 确认框逐笔市价平
- FUT-05 交易参数草稿流：改动后 dirty 提示、重置/确定只提交变化字段；live 切换需危险确认（代码走查）
- FUT-06 轮询：持仓 5s / config 10s 自动刷新

### I. 新闻与市场
- NEWS-01 市场动向 4 StatCard 与 pulse 接口一致
- NEWS-02 新闻流：列表渲染、来源 Segmented 切换计数、关键词 Tag 点选反向筛选、closable 清除
- NEWS-03 「立即抓取」：需登录、success/warning（部分源失败）文案
- NEWS-04 财经日历：高影响事件列表、预期/前值、过期事件灰显、刷新按钮 fetched 计数
- NEWS-05 近7日走势 Sparkline 与统计周期/更新时间
- NEWS-06 空态：暂无新闻/暂无高影响事件

### J. 交易所账户
- ACC-01 账户概要卡：市场/环境/API Key 掩码/连通性；未配置显示"未配置"
- ACC-02 表单保存：label/环境/启用；密钥留空=不修改（走 patch 逻辑）
- ACC-03 「测试连接」→ ok/warning message、连通性字段刷新
- ACC-04 接入说明静态文案完整性
- ACC-05 保存/测试均需登录（requireAuth 包装）

### K. 移动视图（宽屏下的行为 + 代码走查）
- MOB-01 宽屏访问 /m → 应重定向 /admin（验证切换按钮的真实效果）
- MOB-02 走查疑点：MobileHome「合约引擎状态」跳 /m/agent、「全部」跳 /m/orders —— 路由表中不存在，疑为死链（会被 * 兜底弹回 /m）
- MOB-03 MobileStrategy：启动按钮 disabled 条件与 PC 多实例语义不一致（文案"同一时间只能运行一个策略"疑为过时）

### L. 横切关注点
- CRS-01 浏览器 Console 全程无未捕获错误/React key 警告
- CRS-02 网络面板：无 4xx/5xx 非预期请求；轮询频率符合设计
- CRS-03 WS 断线重连：K 线补拉逻辑（代码走查 + 观察顶栏状态位）
- CRS-04 写操作鉴权：所有 POST/PATCH/DELETE 应带 Authorization

## 执行顺序与判定标准

1. 按 A→B→C→D→E→F→G→H→I→J→K 顺序逐菜单执行（登录先行，其余只读在前、写在后）。
2. 每条 case 记 PASS / FAIL / OBSERVE（疑点），FAIL/OBSERVE 全部落问题文档，不当场修改。
3. 涉及真实资金路径（live 模式、真实下单）只做 dry_run 链路与代码走查，不切 live。
