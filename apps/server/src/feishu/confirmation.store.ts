import { Injectable, Logger } from '@nestjs/common';
import { TradingToolsService } from './tools/trading-tools.service';

/** 一次被拦截的写操作意图 */
export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  /** 展示给用户的摘要（来自工具参数） */
  label: string;
}

interface PendingEntry {
  actions: PendingAction[];
  expiresAt: number;
}

const TTL_MS = 60_000;

/**
 * 写操作确认存储（内存级，进程重启即失效——宁可让用户重新发起，
 * 也不让一个过期意图在重启后被「确认」执行）。
 *
 * 流程：LLM 循环里写工具被 shouldIntercept 拦截 → push(chatId) 存意图并回确认卡
 * → 用户回「确认」→ confirm() 逐条经 TradingToolsService.executeWrite 执行并汇总；
 * 回「取消」或 60s 过期 → 作废。同一 chat 后到意图覆盖先到（只保留最新一批）。
 */
@Injectable()
export class ConfirmationStore {
  private readonly logger = new Logger(ConfirmationStore.name);
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly tradingTools: TradingToolsService) {}

  /** 拦截到写工具时调用：合并同批（一轮模型可能并发多个 tool_calls），重置 TTL */
  push(chatId: string, action: PendingAction): void {
    const cur = this.pending.get(chatId);
    const actions = cur && cur.expiresAt > Date.now() ? [...cur.actions, action] : [action];
    this.pending.set(chatId, { actions, expiresAt: Date.now() + TTL_MS });
    this.logger.log(`群 ${chatId} 暂存待确认操作：${action.tool}（${actions.length} 项，60s 内有效）`);
  }

  hasPending(chatId: string): boolean {
    const e = this.pending.get(chatId);
    if (!e) return false;
    if (e.expiresAt <= Date.now()) {
      this.pending.delete(chatId);
      return false;
    }
    return true;
  }

  /** 用户回「确认」：逐条执行并返回汇总结果卡文案 */
  async confirm(chatId: string): Promise<string> {
    const entry = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (!entry || entry.expiresAt <= Date.now()) {
      return '没有待确认的操作（可能已过期），请重新发起。';
    }
    const lines: string[] = [];
    for (const a of entry.actions) {
      // 参数在拦截时已解析为对象，直接交给执行器
      const result = await this.tradingTools.executeWrite(a.tool, a.args ?? {});
      lines.push(`· ${a.label}\n  ${result}`);
    }
    return `【操作执行结果】\n${lines.join('\n')}`;
  }

  /** 用户回「取消」 */
  cancel(chatId: string): string {
    const had = this.hasPending(chatId);
    this.pending.delete(chatId);
    return had ? '已取消待确认的操作。' : '当前没有待确认的操作。';
  }

  /** 确认卡正文 */
  static buildConfirmCard(actions: PendingAction[]): string {
    return [
      '【需要确认的操作】',
      ...actions.map((a) => `· ${a.label}`),
      '',
      '回复「确认」执行，回复「取消」放弃；60 秒未确认自动作废。',
      '本消息不进 LLM，直接在服务端执行白名单内的固定操作。',
    ].join('\n');
  }
}
