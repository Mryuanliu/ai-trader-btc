# 策略开发指南（P4）

> 面向对象：想在平台上写一个自动交易策略的开发者。
> 全文以仓库内真实代码为准：契约定义在 `apps/server/src/strategy/types.ts`，
> 共享类型在 `packages/shared/src/strategy-sdk.ts`，
> 两个可参考的完整实现：`martingale-grid.strategy.ts`（网格/篮子范式）、
> `trend-following.strategy.ts`（趋势/单笔范式）。

---

## 1. 架构总览

```
策略(你写的) ──onTick(ctx, exec)──▶ 执行器(平台) ──▶ 交易服务 ──▶ 交易所
     ▲                                    │
     └──── ctx(行情/仓位/挂单快照) ◀──────┘
```

三个角色，你只需要关心第一个：

| 角色 | 职责 | 你能碰吗 |
|---|---|---|
| **TradingStrategy** | 决策逻辑：何时开仓/加层/平仓/挂单 | **你写** |
| **StrategyExecutor** | 把意图翻译成下单调用（记账/对账/Lot 结算自动完成） | 只调用，不实现 |
| **StrategyRunner** | 调度：多实例管理、tick 驱动、重启恢复 | 平台内部 |

**硬性规则**：策略不能直接碰交易所适配器或数据库 —— 所有交易必须经执行器，
否则下单记账、成交对账、篮子归因都会漏掉。

---

## 2. 最小可运行策略

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { StrategyContext, StrategyExecutor, TradingStrategy } from './types';

const DEFAULT_PARAMS: Record<string, unknown> = {
  qty: 0.001,        // 每次开仓数量
  leverage: 10,      // 杠杆（会真正生效，见 §5）
  takeProfitPct: 0.02,
};

const PARAM_SCHEMA = {
  type: 'object',
  properties: {
    qty: { type: 'number', title: '单次开仓数量', minimum: 0.0001 },
    leverage: { type: 'integer', title: '杠杆', minimum: 1, maximum: 20 },
    takeProfitPct: { type: 'number', title: '止盈(比例)', minimum: 0.0005 },
  },
} as const;

@Injectable()
export class MyStrategy implements TradingStrategy {
  readonly name = 'my_strategy';           // 唯一标识（snake_case）
  readonly label = '我的策略';              // 展示名
  readonly description = '一句话说清策略思路';
  readonly defaultParams = DEFAULT_PARAMS;
  readonly paramSchema = PARAM_SCHEMA;

  // 上架必需（见 §6）：没有 manifest 的策略 Hub 会拒绝加载
  readonly manifest = {
    version: '1.0.0',
    author: 'your-name',
    capabilities: {
      timeframes: ['1m'],      // 需要的 K 线周期
      needsTicker: true,       // 是否需要逐笔报价
      markets: ['futures'],
      autoExit: true,          // 策略会自己平仓（诚实填写）
    },
    riskNotes: ['示例风险提示：本策略不加止损，趋势行情会持续浮亏'],
  };

  private entryPrice = 0;

  normalizeParams(raw?: Record<string, unknown> | null): Record<string, unknown> {
    // 非法值回落默认：策略永不因参数崩溃
    return { ...DEFAULT_PARAMS, ...(raw ?? {}) };
  }

  onStart(): void { this.entryPrice = 0; }   // 启动时重置内部状态
  onStop(): void { this.entryPrice = 0; }

  async onTick(ctx: StrategyContext, exec: StrategyExecutor): Promise<void> {
    const p = ctx.params as { qty: number; takeProfitPct: number };

    // 无持仓 → 开多
    if (ctx.openLots.length === 0) {
      const r = await exec.openLot({
        direction: 'LONG',
        quantity: p.qty,
        leverage: 10,                  // 策略自己声明杠杆（覆盖平台配置）
        reason: 'signal',              // 审计留痕
      });
      if (r.lotId) this.entryPrice = ctx.price;
      return;
    }

    // 有持仓 → 达到止盈线全平
    const entry = ctx.openLots[0].entryPrice;
    if (ctx.price >= entry * (1 + p.takeProfitPct)) {
      await exec.closeLot(ctx.openLots[0].id, 'TAKE_PROFIT');
    }
  }

  getState(): Record<string, unknown> {
    // 前端「运行状态」卡片展示这里的内容；写「正在等什么」派生字段最有用
    return { entryPrice: this.entryPrice };
  }
}
```

注册一行（`strategy-registry.service.ts`）：

```ts
constructor(martingaleGrid: MartingaleGridStrategy, myStrategy: MyStrategy) {
  this.register(martingaleGrid);
  this.register(myStrategy);   // ← 加这一行
}
```

---

## 3. 契约参考：onTick 的上下文与执行器

### StrategyContext（每次 tick 的只读快照）

| 字段 | 类型 | 说明 |
|---|---|---|
| `instanceId` | `string` | 实例标识 `策略名:交易对`。多实例下每个实例只看到**自己的**仓位 |
| `symbol` | `string` | 交易对 |
| `price` | `number` | 最新成交价（挂单触发、展示用） |
| `markPrice` | `number` | 标记价。**浮盈判定用它**（抗单笔插针），取不到时回退 `price` |
| `atr` | `number` | 1m ATR14（平台预计算） |
| `candles` | `Candle[]` | 1m K 线（约 60 根，够算均线） |
| `openLots` | `StrategyLotView[]` | **本实例**的未完结仓位单（含 `hasPendingClose`，见 §4） |
| `openOrders` | `StrategyOrderView[]` | **本实例**的未成交挂单 |
| `availableMargin` | `number` | 可用保证金（读取失败按 0，策略自行判断） |
| `netQty` | `number` | 交易所净持仓（正多负空） |
| `params` | `Record<string, unknown>` | 归一化后的参数 |
| `now` | `number` | 当前时间戳（策略内用 `ctx.now` 而不是 `Date.now()`，便于测试） |

### StrategyExecutor（策略唯一的交易入口）

| 方法 | 语义 | 注意 |
|---|---|---|
| `openLot({direction, quantity, leverage?, reason})` | 市价开仓，返回 `lotId` | **可能返回 `lotId: null`**：真实成交有延迟，Lot 由对账任务补建。下一 tick 会在 `ctx.openLots` 里看到，不影响正确性 |
| `closeLot(lotId, reason)` | 全量平掉指定 Lot | Lot 模型**不做部分平仓** |
| `placeStopOrder({direction, stopPrice, quantity, leverage?, reason})` | 挂 STOP 触发单 | BUY 上破触发 / SELL 下破触发；交易所负责触发，平台不轮询 |
| `cancelOrder(orderId)` | 撤销挂单 | 篮子出场前必须先撤挂单（否则平仓同时可能被触发建新仓） |

所有方法失败都返回 `{ok:false, error}` 或 `{lotId:null, error}` 而**不抛异常** ——
策略按业务分支处理，不必 try/catch。

---

## 4. 多实例语义（重要）

平台支持**同一策略跑多个币种、同一币种跑多个策略**：

- 实例标识 `instanceId = 策略名:交易对`（如 `martingale_grid:BTCUSDT`）
- **仓位隔离**：`ctx.openLots` / `ctx.openOrders` 已按实例过滤——
  你只会看到自己实例的仓，不会误平别人的
- **篮子隔离**：每个实例有独立的篮子（绩效按实例归因）
- **启动拦截**：启动新实例时只会被「无归属」的仓拦住；
  属于其他实例的仓不算阻塞
- **策略对象是单例**：`onStart`/`onStop`/`onTick` 可能被多个实例并发调用，
  **内部状态必须按 `ctx.instanceId` 区分**（用 `Map<instanceId, State>`），
  或者把状态放进 DB/订单（如上面最小示例用 `entryPrice` 就不够健壮——
  参考马丁网格如何用 `ctx.openLots` 反推状态而不是自持变量）

### 在途平仓与幂等

`closeLot` 下单到成交落库之间有窗口期（Lot 仍是 OPEN）。
策略若在多个 tick 里重复判定「该平仓」，会重复下单——第二次会变成反向开仓。
**必须检查 `lot.hasPendingClose`**：

```ts
const inflight = ctx.openLots.filter((l) => l.hasPendingClose).length;
if (inflight > 0) return; // 出场已在进行中，本 tick 只等结果
```

同理：篮子出场前**撤单失败要中止本轮出场**（下 tick 重试），不能静默继续。

---

## 5. 参数与杠杆

- `paramSchema` 是标准 JSON Schema（`properties` + `type`/`title`/`minimum`…），
  前端据此**自动渲染**参数表单（number→数字框、integer→数字框、boolean→开关、enum→下拉）
- `normalizeParams` 必须容忍任意输入：非法值回落默认，**宁可保守不要抛错**
- **`leverage` 会真正生效**：`openLot`/`placeStopOrder` 传入的 `leverage`
  覆盖平台配置值（曾出现「参数写 5x、实际按配置 12x 下单」的事故，已修复——
  新增参数时先确认它被消费，不要只写进日志）
- **`symbol` 是保留字段**：启动弹窗里的「运行币种」不进入 `params`

---

## 6. 上架清单

策略要能被启动（`POST /api/strategy/start`），必须通过 Hub 检查：

1. ✅ `manifest` 齐全（`version`/`author`/`capabilities`/`riskNotes`）
2. ✅ 策略在注册表里（registry 构造函数注册）
3. ✅ 前端「策略管理」页把它打开（enabled）

`capabilities` 诚实填写：

| 字段 | 用途 |
|---|---|
| `timeframes` | 平台只推送声明过的周期 |
| `needsTicker` | false 时只用 K 线收盘价驱动 |
| `autoExit` | 告知用户「该策略会自己平仓」——与「停止后持仓保留」形成对照 |
| `suggestedMaxLayers` | 仅展示，平台不做风控 |

**平台不拦截任何交易**——风险控制只有两道：上架时的 `riskNotes` 必读、
实盘模式启动时的二次确认弹窗。

---

## 7. 测试

参考 `apps/server/src/strategy/__tests__/martingale-grid.spec.ts`（27 项测试）：

- 用 `makeContext(overrides)` 构造 `StrategyContext`（注意 `instanceId` 必填）
- 断言 `exec.openLot/closeLot/placeStopOrder/cancelOrder` 的调用（mock executor）
- **不要在测试里 `chdir`**：它是进程级全局状态，会污染并发用例，
  且表象与真实 bug 极其相似

```bash
cd apps/server && npx vitest run src/strategy
```

---

## 8. 上线前自查

- [ ] `onTick` 全程不抛异常？抛了会被实例级 catch 记录，但策略会停摆一轮
- [ ] 重复触发防护？（同一信号在多个 tick 重复开仓）
- [ ] 在途平仓检查 `hasPendingClose`？
- [ ] 出场前先撤挂单、撤单失败中止出场？
- [ ] 浮盈判定用 `markPrice` 而不是 `price`？
- [ ] 内部状态按 `ctx.instanceId` 隔离（多实例并发安全）？
- [ ] `getState()` 输出「正在等什么」的派生字段？（用户最常问的就是这个）
- [ ] 止盈/止损等百分比对**手续费**敏感？（合约往返约 0.1%，间距别低于成本）
