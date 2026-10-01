import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BasketDirection, LotDirection } from '@ai-trader/shared';
import {
  BasketClosedEvent,
  EventBusService,
  LotClosedEvent,
  LotOpenedEvent,
  ProtectionTrippedEvent,
} from '../common/events';
import { FeishuService } from './feishu.service';

/**
 * 飞书交易通知：订阅进程内成交/结束事件，主动推送 Markdown 卡片到指定群。
 *
 * 与主交易链路解耦——推送 fire-and-forget + catch 记日志，任何失败都不回抛。
 * 未配置 FEISHU_APP_ID/SECRET/CHAT_ID 或 FEISHU_PUSH_ENABLED=false 时整体 no-op；
 * `dry_run` 模拟成交不推送，只推 testnet/live 真实链路。
 */
@Injectable()
export class FeishuNotificationService implements OnModuleInit {
  private readonly logger = new Logger(FeishuNotificationService.name);
  private chatId?: string;

  constructor(
    private readonly events: EventBusService,
    private readonly feishu: FeishuService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('FEISHU_PUSH_ENABLED') !== false;
    const chatId = this.config.get<string>('FEISHU_CHAT_ID');
    if (!enabled || !chatId || !this.feishu.isConfigured()) {
      this.logger.log(
        '飞书推送未启用（缺 FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID 或 FEISHU_PUSH_ENABLED=false）',
      );
      return;
    }
    this.chatId = chatId;

    this.events.on$('lotOpened').subscribe((e) => {
      if (e.mode === 'dry_run') return;
      this.push(this.formatOpen(e), '开仓成交');
    });
    this.events.on$('lotClosed').subscribe((e) => {
      if (e.mode === 'dry_run') return;
      this.push(this.formatClose(e), '平仓结束');
    });
    this.events.on$('basketClosed').subscribe((e) => {
      if (e.mode === 'dry_run') return;
      this.push(this.formatBasket(e), '整轮了结');
    });
    // 熔断停实例是低频且关键的平台安全事件，各模式（含 dry_run）都推——
    // 运营必须第一时间知道「哪个实例被兜底停掉了、持仓需手动处理」。
    this.events.on$('protectionTripped').subscribe((e) => {
      this.push(this.formatProtection(e), '熔断停实例');
    });

    this.logger.log(`飞书交易通知已启用 -> chat ${chatId}`);
  }

  private push(text: string, kind: string): void {
    if (!this.chatId) return;
    // 不 await：推送慢/失败都不能拖住或打断事件流
    void this.feishu.sendCard(this.chatId, text).catch((err: any) => {
      this.logger.warn(`飞书${kind}推送失败：${err?.message || err}`);
    });
  }

  formatOpen(e: LotOpenedEvent): string {
    return [
      `【开仓成交】${e.symbol} ${dirLabel(e.direction)} ${qty(e.quantity)} @ ${price(e.entryPrice)}`,
      `手续费 ${e.fee.toFixed(2)} USDT · 实例 ${e.strategyInstanceId || '手动'} · ${e.mode} · ${fmtTime(e.ts)}`,
    ].join('\n');
  }

  formatClose(e: LotClosedEvent): string {
    return [
      `【平仓结束】${e.symbol} ${dirLabel(e.direction)} ${qty(e.quantity)}`,
      `${price(e.entryPrice)} → ${price(e.exitPrice)} · 净盈亏 ${signed(e.realizedPnl)} USDT (${(e.returnPct * 100).toFixed(2)}%)`,
      `原因 ${e.exitReason} · 篮子 ${e.basketCode || '-'} · ${e.mode}`,
    ].join('\n');
  }

  formatBasket(e: BasketClosedEvent): string {
    const pct = e.returnPct === null ? '-' : `${(e.returnPct * 100).toFixed(2)}%`;
    return [
      `【整轮了结】${e.code} ${e.symbol} ${dirLabel(e.direction)}`,
      `层数 ${e.layerCount} · 整体净盈亏 ${signed(e.realizedPnl)} USDT (${pct})`,
      `手续费 ${e.feeTotal.toFixed(2)} · 资金费 ${e.fundingFee.toFixed(2)} · ${e.mode}`,
    ].join('\n');
  }

  formatProtection(e: ProtectionTrippedEvent): string {
    return [
      `⚠️【熔断已停实例】${e.strategyName} @ ${e.symbol}`,
      `原因：${e.reason}（连亏 ${e.consecutiveLosses} 笔 / 回撤 ${e.drawdownPct.toFixed(2)}%）`,
      `实例已停止产生新动作 · 撤未成交挂单 · 持仓保留需手动处理 · ${fmtTime(e.ts)}`,
    ].join('\n');
  }
}

const dirLabel = (d: LotDirection | BasketDirection): string =>
  d === 'LONG' ? '多' : d === 'SHORT' ? '空' : '混合';
const price = (n: number): string => n.toFixed(2);
const qty = (n: number): string => String(Number(n.toFixed(8)));
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const fmtTime = (ts: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
