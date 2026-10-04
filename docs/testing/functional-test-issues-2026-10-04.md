# 功能测试问题记录（2026-10-04）

> 配套计划：`docs/testing/functional-test-plan.md`。仅记录，不修复。
> 严重度：P0 阻断 / P1 功能缺陷 / P2 体验或文案 / P3 疑点或建议
> 执行方式：浏览器实跑（5173→3001，dry_run/模拟盘）+ 代码走查 + curl 交叉验证。全程未切 live、未动真实资金。

## P1 功能缺陷

### 1. 策略详情页 DSR 闸门徽标恒显"未测"（字段读取错误）
- 位置：`apps/web/src/pages/admin/AdminStrategyDetail.tsx` 读 `strategy.manifest?.backtestRef`
- 事实：API `/api/strategy` 返回的 descriptor 中 `backtestRef` 挂在**顶层**（curl 验证 `backtestRef: {dsr:0.851487, verdict:'pass'}`），`manifest` 仅含 author/capabilities/riskNotes/version → 前端恒为 undefined
- 对照：`AdminStrategyGovernance.tsx` 正确使用顶层 `s.backtestRef`，治理页快照显示正常，详情页恒显"DSR 闸门·未测"
- 影响：实跑中 trend_following 已有 sweep 达标记录（DSR 0.640，闸门弹窗实时返回可见），详情页却显示"未测"，误导上架决策
- 关联 case：STR-08

### 2. 策略"一键平仓 → 停止"竞态遗留仓位，平仓后策略立即重开新轮
- 复现（martingale_grid · BTCUSDT，dry_run）：点「一键平仓」执行成功 → 约 2 秒后策略自动开出新 SHORT 0.01 @84757.5（`firstOrderMarket=true` 首单市价语义）→ 再点「停止策略」→ 新仓无人管理，遗留 orphan OPEN lot（`b6f378fc`）
- 后续：该 lot 约 2 分钟后被止盈/止损监控自动了结（10:55 开 → 10:57:58 了结，篮子 BK-20261004-003 可见），未造成实际风险，但属于**停止策略后仍有孤儿持仓窗口期**的真实链路缺陷
- 建议方向（不改）：平仓确认框应联动"先停止策略"或平仓期间挂起策略 tick
- 关联 case：STR-05/06

## P2 体验 / 接口契约

### 3. 回测台「双模式对照」对策略不存在的参数静默 no-op 仍报"对照完成"
- martingale_grid 的 manifest defaultParams 无 `useVolSizing`（对照参数输入框默认值），点对照后 TRUE/FALSE 两次运行结果完全相同（回撤 0.91/0.91、提升 0.00），界面照常展示"对照完成"表格
- 应前置校验参数是否在该策略参数集中并提示，否则产出两组相同数据误导性强
- 关联 case：BKT-06

### 4. 移动视图死链：MobileHome 快捷入口指向不存在的路由
- `apps/web/src/pages/mobile/MobileHome.tsx` 中「合约引擎状态」`navigate('/m/agent')`、「全部」`navigate('/m/orders')`；路由表仅注册 `/m`、`/m/trade`、`/m/strategy`
- 后果：点击被 `*` 兜底弹回 `/m`，功能入口失效但不报错
- 关联 case：MOB-02（窄屏无法实跑，代码走查确认）

### 5. `/api/lots` 的 status 查询参数大小写敏感且静默忽略
- 接口返回的 lot 状态为大写枚举（`OPEN`/`CLOSED`），但过滤仅识别小写 `status=open`（`lots.controller.ts` 第 30 行 `status === 'open'`）；传 `status=OPEN` 静默落全量分支返回 87 条含 CLOSED 记录
- 返回值不能原样传回查询，易误判"过滤失效"；建议大小写不敏感或对未知值报错
- 关联 case：FUT-04 交叉验证时发现

## P3 疑点 / 建议

### 6. AdminFutures 指标区声明 4 列实放 3 卡（布局遗留）— 代码走查，关联 FUT-02
### 7. MobileStrategy 文案"同一时间只能运行一个策略"与 PC 多实例语义（策略+币种独立实例）不符，疑为过时文案 — 关联 MOB-03
### 8. `/api/strategy/status` 仅反映第一个实例：STR 实例数=2 期间顶栏/列表 Badge 判断口径不完整（多实例改造遗留）
### 9. 闸门上架 Modal 关闭未销毁：重开时 textarea 残留上次填写的强推理由（antd Modal destroyOnClose 未设），有误导提交旧理由的风险
### 10. Console 基线警告（不阻断）：antd `Modal destroyOnClose`、`Tooltip overlayStyle` 弃用警告；React Router future flag 提示；socket.io WS 连接失败告警各 1+ 次
### 11. 【未复现疑点】治理页测试中两次遭遇"页面意外跳转"（一次回 /admin/strategy、一次至 /admin/strategy/donchian_breakout 详情）。治理组件源码无 onRow/自动导航逻辑，Modal 内唯一导航是「research / sweep」链接（目标 /admin/backtest?strategy=…，与目的地不符），无法归因；疑为外部并行操作干扰。若后续复现需立查
### 12. AI 行情「模型推理过程」Collapse 为条件渲染（`data?.reasoning` 非空），当前 deepseek-flash 不返回 reasoning → 面板恒不显示，页面无提示说明

## OBSERVE（实跑条件不足，以走查覆盖）

- FUT-03 距强平 <15% 红标、FUT-04 平仓按钮禁用/Tooltip：当前交易所无持仓，走查确认逻辑存在
- NEWS-04 过期事件灰显：财经日历本期无高影响事件（接口 count=0），走查覆盖；刷新链路实跑 PASS（201→重取）
- STR-15 / FUT-05 live 危险确认：按计划不切 live，走查确认
- AIM-03 模型不可用降级分支：当前模型可用，走查确认
- NAV-04/05 顶栏徽标与 futures 开关联动：停用→Tag"已停止"→恢复"运行中"实跑通过（开关切换无 message 提示，仅 Tag 联动，提示偏弱但可接受）

## 结论统计

| 模块 | 结果 |
|---|---|
| A 登录鉴权 | 6/6 PASS |
| B 全局框架 | 基本 PASS（NAV-06 宽屏 /m 重定向 PASS） |
| C 总览看板 | OVR-01/03/04/05/06/07/08 PASS |
| D 策略管理 | 主链路 PASS，发现 P1×2（#1 #2） |
| E 上架治理 | GOV-01~07 全 PASS（闸门拦截不写盘、强推留痕、下架复原均验证） |
| F 回测台 | BKT-01~10 PASS，发现 P2#3 |
| G AI 行情 | AIM-01~04 PASS，05 条件不满足（P3#12） |
| H 合约面板 | FUT-01/02/05/06 PASS，03/04 走查 |
| I 新闻 | NEWS-01~05 PASS，06 部分走查 |
| J 账户 | ACC-01~04 PASS（保存/测试连接/掩码/留空不改语义），05 走查 |
| K 移动视图 | MOB-01 PASS，MOB-02/03 走查（P2#4、P3#7） |
| L 横切 | 无未捕获错误、无 4xx/5xx（304 为缓存重验）；写操作均带鉴权 |

未发现 P0。环境已复原：trend_following 已下架回原状态、无遗留 OPEN lot、合约链路已重新启用、杠杆草稿已重置 10x、策略全部停止。
