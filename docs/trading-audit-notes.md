# 交易链路审计记录（2026-09-02）

## 结论

当前真实/模拟盘链路整体可运行，但存在三个高优先级一致性风险：成交与 Lot 生命周期非原子、开仓上限在部分失败场景下会超限、`trade_fills.orderId` 类型与订单 UUID 类型不一致。当前数据库存在 35 个未平仓 Short Lot、35 个 Short 方向上限违规，且 2 笔 FILLED 合约订单缺少交易所单号导致对账无法回查。

## 核对 SQL

```sql
-- 订单/成交缺口
SELECT o.id, o."createdAt", o.side, o.status, o."exchangeOrderId"
FROM orders o
LEFT JOIN trade_fills f ON f."orderId" = o.id::text
WHERE o.market = 'futures'
  AND o.status IN ('FILLED', 'PARTIALLY_FILLED')
  AND f.id IS NULL;

-- Lot 状态与出场留痕
SELECT status, direction, count(*) n, sum(quantity) qty,
       count(*) FILTER (WHERE "closeOrderId" IS NULL) missing_close_order
FROM position_lots
WHERE market = 'futures'
GROUP BY status, direction;

-- 每方向仓位上限
SELECT direction, count(*) n
FROM position_lots
WHERE market = 'futures' AND status = 'OPEN'
GROUP BY direction;
```

## 2026-09-02 实测

- 订单：合约 FILLED 81，FAILED 62；无 NEW/PARTIALLY_FILLED 存量。
- 成交：`trade_fills` 100 条；27 条手续费为 0，说明历史对账未按当前代码兜底估算手续费。
- Lot：51 条，OPEN Short 35、CLOSED Long 16；Short 方向超过 `MAX_OPEN_LOTS_PER_DIRECTION = 3`。
- 16 个 CLOSED Lot 的 `closeOrderId` 为空，无法从 Lot 反查平仓订单。
- 2 笔合约 FILLED 订单无 `exchangeOrderId`，也无成交明细，永久无法交易所对账。
- 23 笔历史平仓订单 `lotId` 为空；新的 `lotId` 迁移只阻止增量错配，不能修复历史归属。
- 当前服务日志只记录决策和少量业务告警；下单请求、订单状态变化、对账明细没有结构化事件表。

## 前后端拉通改造清单

### 2026-09-03 复核结论

- 通过 Clash 代理回查币安模拟盘：当前只有一笔 BTCUSDT SHORT `-0.0709` 持仓，`openOrders` 为 0，因此交易所侧没有任何止盈止损单。
- 本地 35 个 OPEN SHORT Lot 合计 `0.0665`，与交易所持仓差 `0.0044`。
- 差额来自两笔本地 `FILLED` 订单：
  - `ft_1788250336795_ugkovm`，SELL 0.0024 @ 78401；
  - `ft_1788250456769_s03rdx`，SELL 0.0020 @ 78427.645。
- 这两笔在币安实际已成交，但本地没有 `exchangeOrderId`、`trade_fills` 和 Lot。根因是 `syncOpenOrders()` 通过 `clientOrderId` 回查后只回写状态、数量、均价，漏写 `exchangeOrderId`，导致后续 `syncPendingFills()` 永远跳过。
- 已修复：
  - 订单状态同步时补写 `exchangeOrderId`；
  - 合约对账允许通过 `clientOrderId` 回查并补写 `exchangeOrderId`。
- 后续服务运行一轮对账后，这两笔应补出成交明细和 Lot，本地/交易所持仓差额应归零。

### P0：先修交易正确性

1. `LotService.settleFromCloseFill()` 结算成功后没有把 `closeOrderId` 写入 Lot，导致 16 个已关闭 Lot 无法反查平仓单，订单页也无法用 Lot 精确显示盈亏。必须补写该字段。
2. 把「订单状态更新、成交明细、Lot 创建/结算」放进同一个数据库事务；不要在事务外先写成交再调用 Lot 服务。
3. `trade_fills` 当前实际按 `orderId` 只写一条，但表没有唯一约束；对账和同步存在并发重复写风险。短期加 `UNIQUE(orderId)`，长期改为支持交易所 `tradeId` 的增量流水模型。
4. `syncPendingFills()` 不能只处理 `FILLED/PARTIALLY_FILLED`；`CANCELED` 订单也可能已有部分成交。已记录过部分成交的订单后续继续成交时，现有代码不会更新数量、均价、手续费。需要重做成增量或全量覆盖逻辑。
5. 对账必须保存交易所成交时间、成交 ID、原始手续费；不能统一用本地 `new Date()`。否则延迟补账会污染“今日盈亏”。
6. 将 `trade_fills.orderId` 迁移为 UUID，或至少统一类型并加索引；当前与 `orders.id` 类型不一致，查询依赖运行时 cast。
7. 对已存在的历史数据执行修复脚本：
   - 2 笔 `FILLED` 但没有 `exchangeOrderId` 且没有成交明细的订单；
   - 2 笔成交价为 0 的 `FILLED` 订单；
   - 27 条手续费为 0 的成交；
   - 16 个 `closeOrderId` 为空的 CLOSED Lot；
   - 23 个 `lotId` 为空的历史平仓单；
   - 35 个 OPEN Short Lot 超过方向上限。
   能通过交易所回查的回查；不能安全回查的显式标记为 `RECONCILIATION_REQUIRED`，不要继续静默参与统计。
8. 手动平仓接口必须校验 `lot.symbol === body.symbol ?? cfg.symbol`，避免把 Lot ID 与另一个交易对组合提交。
9. 关闭 Lot 必须校验目标 Lot 数量等于平仓数量。当前模型承诺全量平仓，但 `settleFromCloseFill()` 用 `min()` 后仍把 Lot 置为 `CLOSED`，会吞掉未平完数量。
10. `FuturesPositionService.getNetQuantity()` 在 hedge mode 下只取第一行持仓；同 symbol 可能同时存在 LONG/SHORT 两条。必须按方向/净额正确汇总。查询交易所失败时不能默认按 0 处理后继续开仓，应显式 fail-closed。
11. 平仓风控应校验交易所 `positionSide` 和该方向数量，而不是只检查绝对持仓大于 0。
12. 统一运行模式来源。`futures_agent_configs.mode` 与 `APP_RUN_MODE` 可能不一致，而 `ExchangeRegistry` 用 `APP_RUN_MODE` 选环境、`FuturesTradingService` 用配置行 mode 判断 dry-run/live。必须收敛为单一权威来源。
13. 区分“明确失败”和“网络未知”。适配器超时/连接失败后，当前订单被置为 `FAILED`，但交易所可能已成交。应引入 `UNKNOWN` 状态，并立即用 `clientOrderId` 回查；服务启动时也要回查遗留未知单。
14. 在下单前做本地 Lot 数量与交易所持仓双向对账；差异超过阈值时禁止新增开仓，并生成风控事件。

### P0：修 API 与前端契约

15. `OrderDTO` 缺少 `reduceOnly`、`lotId`、`positionSide`、`leverage`、`filledQuantity`。前端无法准确区分“开空”和“平多”，也无法展示/追踪 Lot 归属。补齐 DTO 后同步更新前后端类型。
16. `/orders/round-trips` 语义错误：前端把 `market='futures'` 当成 `symbol` 传入，后端却用它过滤 `trade_fills.symbol`，导致订单页回合盈亏可能恒为空。接口应增加 `market` 参数。
17. 订单查询需要支持状态组。前端“进行中”只传 `NEW`，但实际还包括 `PARTIALLY_FILLED`；后端也只接受单状态。
18. 手动合约下单后，`FuturesTradingService.placeOrder()` 可能在交易所异常时返回 `status=FAILED` 而不是抛错。前端 `AdminFutures.closeLot()` 现在一律提示“已提交平仓”。必须根据返回订单状态显示成功/失败/未知，并展示 `order.error`。
19. 所有写操作成功后的缓存失效不完整：
    - 合约下单需失效 margin、positions、orders、lots、round-trips、overview、decisions、health；
    - 撤单需失效 round-trips、lots、positions；
    - 手动执行决策需失效 orders、lots、margin、health、overview。
20. WebSocket 只维护 `lastOrder`，没有触发 React Query 更新。应把 `order/decision/risk/lot` 事件接入全局 query cache，减少 15-30 秒轮询造成的旧数据窗口。

### P0：修展示口径

21. `AdminOrders` 的回合盈亏应改用修复后的 `market=futures`；Lot 盈亏优先，FIFO 回合只作为历史数据兜底。
22. `AdminOrders` 的“进行中”过滤必须包含 `PARTIALLY_FILLED`。
23. 订单表应显示合约方向意图：开多、开空、平多、平空；仅显示 BUY/SELL 会误导。
24. 对数据质量异常做前端标记：缺少交易所单号、成交价 0、手续费 0、Lot 缺少归属、本地/交易所持仓不一致。
25. `AdminFutures` 的本地 Lot 净额与交易所持仓不一致时，不能只显示 Tag，应升级为阻断手动开仓/平仓的醒目风险条，并展示最近一次对账时间。
26. `MobileOrders` 查询缺少 `market='futures'`，会把历史现货订单混入移动端。
27. `MobileTrade` 只用本地 Lot 展示多空净额，应同时显示交易所 positionRisk，并在不一致时提示。
28. `AdminFutures` 配置 Slider 每拖动一次就发一次 PATCH。应本地暂存，失焦/确认后提交，避免请求风暴和旧值覆盖。
29. `AdminFutures` 杠杆滑杆的上限/刻度不要硬编码 10；跟随后端 `maxLeverage`。
30. 风控页的统计目前基于当前页 items，应改为后端返回各 level 的 total。

### P1：后端健壮性与审计

31. 增加 `trading_events` 审计表，至少记录：`ORDER_CREATED`、`ORDER_SUBMITTED`、`ORDER_STATUS_CHANGED`、`FILL_RECORDED`、`LOT_OPENED`、`LOT_SETTLED`、`SYNC_STARTED`、`SYNC_COMPLETED`、`RECONCILIATION_MISMATCH`、`EXCHANGE_ERROR`。字段包含 requestId、orderId、lotId、decisionId、clientOrderId、exchangeOrderId、before/after、raw error。
32. 为 `/futures/order`、`/orders`、配置 PATCH 增加真正的 DTO 和 class-validator；当前运行时可传入非法 mode、symbol、数量、价格。`decisionIntervalSec`、`mode` 必须在后端钳制/枚举校验。
33. 取消订单只能作用于 `NEW/PARTIALLY_FILLED`；当前 API 可尝试取消已成交的 dry-run 订单。
34. 撤单失败时不要只写 `order.error`，还要写入风控/交易事件，并让前端拿到结构化错误码。
35. `AllExceptionsFilter` 不应把内部错误原文直接返回给前端；500 返回通用文案，详细堆栈/原文只进日志和审计事件。
36. WebSocket 当前无鉴权且 CORS 为 `*`，订单、决策、风控事件可被匿名监听。前端连接时带 JWT，网关握手校验，CORS 收敛到允许的前端 origin。
37. 将 dry-run 手续费、滑点、费率、最大 Lot 数等硬编码常量迁入配置，并在前端展示当前口径。
38. 对 `FuturesConfigService.update()` 的 `mode` 增加枚举校验，避免写入任意字符串；切换 live/testnet/dry-run 前必须校验持仓和未完成订单。
39. 增加 `POST /futures/sync` 管理端触发接口，用于手动对账；返回新增成交数、Lot 变更数、跳过数、失败数和差异摘要。
40. 增加数据健康接口，返回本审计中的核心检查结果，供前端和监控直接消费。

### P1：测试与验收

41. 单测覆盖：
    - 异步市价单：下单响应 0 成交、后续对账补账；
    - 部分成交后撤单；
    - 并发重复对账不重复写；
    - Lot 全量/部分平仓；
    - hedge mode 多空共存；
    - 交易所查询失败时禁止开仓；
    - 网络未知后的 clientOrderId 回查。
42. 集成测试用 fake adapter 驱动完整链路：决策 → 下单 → 状态同步 → 成交对账 → Lot 结算 → 订单页/持仓页 DTO。
43. 前端测试覆盖：手动平仓失败提示、进行中过滤、合约方向展示、市场过滤、本地/交易所差异告警。
44. 上线前用只读 SQL 复核本文件中的对账查询，结果必须为零差异或异常均已显式标记。
