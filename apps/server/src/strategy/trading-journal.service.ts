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
 * 每日交易运行日志（按天归档的纯文本文件，testnet/live 全模式记录）。
 *
 * 目的：模拟室跑一天后，有一份可直接读/grep 的「当日运行情况」——
 * 生命周期（启停/模式）、每次成交/结算、熔断、以及策略逐轮的决策注解。
 * 用于日终总结、判断策略是否需要调优，不建 DB 表、不接前端。
 *
 * 设计取舍：
 * - **与主交易链路完全解耦**：只订阅进程内事件 + 由 runner 回灌决策/生命周期；
 *   任何写盘失败只 warn，绝不回抛或阻断交易。
 * - **所有模式都记**——测试网正是本日志要总结的对象。
 * - **逐日一个文件** `YYYY-MM-DD.log`（Asia/Shanghai 日切），追加写、串行化避免交错。
 * - **决策去重**：策略每 tick 都会更新 `getState().note`，只在相对上一条**变化**时才写，避免刷屏。
 */
@Injectable()
export class TradingJournalService implements OnModuleInit {
  private readonly logger = new Logger(TradingJournalService.name);
  private readonly dir = process.env.TRADING_JOURNAL_DIR || 'logs/trading-journal';
  /** 串行写队列：所有 append 排成一条链，避免并发写同一文件交错 */
  private queue: Promise<void> = Promise.resolve();
  /** 是否已确保目录存在（惰性 mkdir，只做一次） */
  private dirReady = false;
  /** 每实例上一条决策注解：仅变化才落盘 */
  private lastNoteByInstance = new Map<string, string>();

  constructor(private readonly events: EventBusService) {}

  onModuleInit(): void {
    this.events.on$('lotOpened').subscribe((e) => this.onLotOpened(e));
    this.events.on$('lotClosed').subscribe((e) => this.onLotClosed(e));
    this.events.on$('basketClosed').subscribe((e) => this.onBasketClosed(e));
    this.events.on$('protectionTripped').subscribe((e) => this.onProtection(e));
    this.info('-', 'BOOT', `交易日志目录=${path.resolve(this.dir)}`);
  }

  /** 生命周期事件：策略实例启停 / 运行模式切换 */
  lifecycle(instanceId: string, kind: 'START' | 'STOP' | 'MODE', detail: string): void {
    this.info(instanceId, kind, detail);
  }

  /** 逐轮决策注解：与上一条相同则丢弃；空串忽略 */
  decision(instanceId: string, note: string | undefined | null): void {
    const n = (note ?? '').trim();
    if (!n) return;
    if (this.lastNoteByInstance.get(instanceId) === n) return;
    this.lastNoteByInstance.set(instanceId, n);
    this.info(instanceId, 'DECISION', n);
  }

  /** 实例停止后清其决策去重缓存（重启用全新上下文） */
  forgetInstance(instanceId: string): void {
    this.lastNoteByInstance.delete(instanceId);
  }

  private onLotOpened(e: LotOpenedEvent): void {
    this.info(
      e.strategyInstanceId || '手动',
      'OPEN',
      `${e.direction} ${num(e.quantity)} @ ${num(e.entryPrice)} 费=${num(e.fee, 4)} ${e.mode}`,
    );
  }

  private onLotClosed(e: LotClosedEvent): void {
    this.info(
      e.strategyInstanceId || '手动',
      'CLOSE',
      `${e.direction} ${num(e.quantity)} ${num(e.entryPrice)}→${num(e.exitPrice)} ` +
        `净盈亏=${signed(e.realizedPnl, 2)} (${pct(e.returnPct)}) 原因=${e.exitReason} ` +
        `篮子=${e.basketCode || '-'} ${e.mode}`,
    );
  }

  private onBasketClosed(e: BasketClosedEvent): void {
    this.info(
      e.strategyInstanceId || '手动',
      'BASKET',
      `${e.code} ${e.symbol} ${e.direction} 层数=${e.layerCount} ` +
        `整体净盈亏=${signed(e.realizedPnl, 2)} (${pct(e.returnPct)}) ` +
        `费=${num(e.feeTotal, 2)} 资金费=${num(e.fundingFee, 2)} ${e.mode}`,
    );
  }

  private onProtection(e: ProtectionTrippedEvent): void {
    this.warn(e.instanceId, 'PROTECT', `${e.reason} 连亏=${e.consecutiveLosses} 回撤=${pct(e.drawdownPct / 100)} —— 已停实例`);
  }

  // ------------------------------------------------------------------ 写盘
  private info(instanceId: string, category: string, detail: string): void {
    this.write('INFO', instanceId, category, detail);
  }
  private warn(instanceId: string, category: string, detail: string): void {
    this.write('WARN', instanceId, category, detail);
  }

  private write(level: 'INFO' | 'WARN', instanceId: string, category: string, detail: string): void {
    const line = `[${stamp()}] [${level}] ${instanceId} | ${category} | ${detail}\n`;
    this.queue = this.queue
      .then(async () => {
        if (!this.dirReady) {
          await fs.mkdir(this.dir, { recursive: true });
          this.dirReady = true;
        }
        await fs.appendFile(path.join(this.dir, `${shanghaiDate()}.log`), line, 'utf8');
      })
      .catch((err: Error) => {
        // 写盘失败绝不能反噬交易链路：只记一次 warn
        this.logger.warn(`交易日志写入失败：${err.message}`);
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

/** 当日日期（Asia/Shanghai）用于文件名：YYYY-MM-DD */
function shanghaiDate(): string {
  const p = toParts(shanghaiParts.formatToParts(new Date()));
  return `${p.year}-${p.month}-${p.day}`;
}

/** 行首时间戳：YYYY-MM-DD HH:mm:ss（上海时区） */
function stamp(): string {
  const p = toParts(shanghaiParts.formatToParts(new Date()));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function toParts(list: Intl.DateTimeFormatPart[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const it of list) if (it.type !== 'literal') o[it.type] = it.value;
  return o;
}

const num = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const signed = (n: number, d = 2): string => `${n >= 0 ? '+' : ''}${num(n, d)}`;
const pct = (n: number | null): string => (n === null ? '-' : `${(n * 100).toFixed(2)}%`);
