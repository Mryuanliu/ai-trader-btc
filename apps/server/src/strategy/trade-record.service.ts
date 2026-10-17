import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BasketClosedEvent,
  EventBusService,
  LotClosedEvent,
  LotOpenedEvent,
  ProtectionTrippedEvent,
} from '../common/events';

/**
 * 交易档案事件流（machine-readable trade records）。
 *
 * 与 TradingJournalService 的分工：journal 是**给人读的文本日志**，
 * 本服务是**给分析器读的结构化事件流**——每次交易的开仓点/平仓点/手续费/
 * 持仓费/盈亏逐条落盘，外加策略在每个出场判定点的「为什么没触发」快照
 * （EXIT_TRACE），供 analyze-trades CLI 做事后归因（2026-10-17 实测调优回路）。
 *
 * 设计取舍（与 journal 同款解耦纪律）：
 * - 目录 `logs/trade-records/<实例slug>/events-YYYY-MM-DD.jsonl`，上海时区日切；
 * - 每行一个 JSON 事件（JSONL，可 grep 可 jq 可流式解析）；
 * - 串行写队列防交错；**任何写盘失败只 warn，绝不回抛、绝不阻断交易链路**；
 * - 生命周期事件（LOT_OPEN/LOT_SETTLE/BASKET/ALERT）订阅进程内 EventBus 自动写，
 *   策略零改动就受益；EXIT_TRACE/ENTRY_TRACE 由策略经 ctx.trace() 主动写。
 */
@Injectable()
export class TradeRecordService implements OnModuleInit {
  private readonly logger = new Logger(TradeRecordService.name);
  private readonly dir = process.env.TRADE_RECORD_DIR || 'logs/trade-records';
  /** 串行写队列：所有 append 排成一条链，避免并发写同一文件交错 */
  private queue: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(private readonly events: EventBusService) {}

  onModuleInit(): void {
    this.events.on$('lotOpened').subscribe((e) => this.fromLotOpened(e));
    this.events.on$('lotClosed').subscribe((e) => this.fromLotClosed(e));
    this.events.on$('basketClosed').subscribe((e) => this.fromBasketClosed(e));
    this.events.on$('protectionTripped').subscribe((e) => this.fromProtection(e));
    // FAILED 订单＝废单/失败平仓证据。orderId↔lotId 的关联不在 DTO 里，
    // 由分析 CLI 拿 orderId 回查 orders 表补齐（DB 是权威源，事件流只做辅助索引）。
    this.events.on$('order').subscribe((o) => {
      if (o.status !== 'FAILED') return;
      this.event('-', 'ORDER_FAIL', {
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        orderType: o.type,
        quantity: o.quantity,
        source: o.source,
        error: o.error,
        mode: o.mode,
      });
    });
  }

  /**
   * 写一个事件到实例的当日事件流。
   * instanceId 为 '-' 时进 `_platform` slug（平台级事件）。
   * 调用方约定：payload 只放**可分析的事实数字**，别放展示文案。
   */
  event(instanceId: string | null | undefined, type: string, payload: Record<string, unknown>): void {
    const inst = (instanceId || '-').trim() || '-';
    // 保留字段（ts/time/inst/type）后写且优先生效：避免 payload 里同名键
    // （如订单事件自带的 type=ORDER_TYPE）把档案事件类型盖掉。
    const line = JSON.stringify({ ...payload, ts: Date.now(), time: stamp(), inst, type }) + '\n';
    const file = path.join(this.dir, slugOf(inst), `events-${shanghaiDate()}.jsonl`);
    this.queue = this.queue
      .then(async () => {
        if (!this.dirReady) {
          await fs.mkdir(this.dir, { recursive: true });
          this.dirReady = true;
        }
        // slug 子目录可能首次出现：appendFile 不建父目录，先确保存在
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, line, 'utf8');
      })
      .catch((err: Error) => {
        // 档案写失败绝不能反噬交易链路：只记一次 warn
        this.logger.warn(`交易档案写入失败（${type}）：${err.message}`);
      });
  }

  // -------------------------------------------------- 进程事件 → 档案事件

  private fromLotOpened(e: LotOpenedEvent): void {
    this.event(e.strategyInstanceId, 'LOT_OPEN', {
      symbol: e.symbol,
      direction: e.direction,
      quantity: e.quantity,
      entryPrice: e.entryPrice,
      fee: e.fee,
      source: e.source,
      mode: e.mode,
    });
  }

  private fromLotClosed(e: LotClosedEvent): void {
    this.event(e.strategyInstanceId, 'LOT_SETTLE', {
      symbol: e.symbol,
      direction: e.direction,
      quantity: e.quantity,
      entryPrice: e.entryPrice,
      exitPrice: e.exitPrice,
      realizedPnl: e.realizedPnl,
      returnPct: e.returnPct,
      exitReason: e.exitReason,
      basketCode: e.basketCode,
      mode: e.mode,
    });
  }

  private fromBasketClosed(e: BasketClosedEvent): void {
    this.event(e.strategyInstanceId, 'BASKET', {
      code: e.code,
      symbol: e.symbol,
      direction: e.direction,
      layerCount: e.layerCount,
      realizedPnl: e.realizedPnl,
      returnPct: e.returnPct,
      feeTotal: e.feeTotal,
      fundingFee: e.fundingFee,
      mode: e.mode,
    });
  }

  private fromProtection(e: ProtectionTrippedEvent): void {
    this.event(e.instanceId, 'ALERT', {
      kind: 'PROTECTION_TRIPPED',
      reason: e.reason,
      consecutiveLosses: e.consecutiveLosses,
      drawdownPct: e.drawdownPct,
    });
  }
}

// ------------------------------------------------------------------ 格式化小工具
const shanghaiParts = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function toParts(list: Intl.DateTimeFormatPart[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const it of list) if (it.type !== 'literal') o[it.type] = it.value;
  return o;
}

function shanghaiDate(): string {
  const p = toParts(shanghaiParts.formatToParts(new Date()));
  return `${p.year}-${p.month}-${p.day}`;
}

/** 人类可读时间戳（上海时区，与 journal 对齐） */
function stamp(): string {
  const p = toParts(shanghaiParts.formatToParts(new Date()));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 实例 ID → 目录名：`martingale_grid_v2:BTCUSDT` → `martingale_grid_v2-BTCUSDT` */
export function slugOf(instanceId: string): string {
  if (instanceId === '-') return '_platform';
  return instanceId.replace(/[^A-Za-z0-9:_-]/g, '_').replace(/:/g, '-');
}
