import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmChatService, ChatMessage } from '../agent/llm-chat.service';
import { ToolRegistry } from '../agent/llm-tools';
import { SkillLoaderService } from '../agent/skill-loader.service';
import { McpToolSourceService } from '../agent/mcp-tool-source.service';
import { buildBotSystemPrompt } from '../agent/prompts';
import { FeishuChatSessionEntity, StoredChatMessage } from './entities/feishu-chat-session.entity';
import { TradingToolsService } from './tools/trading-tools.service';
import { ConfirmationStore, PendingAction } from './confirmation.store';

/** 会话保留的最大消息条数（user+assistant 各算一条） */
const HISTORY_LIMIT = 20;

export interface AgentAskResult {
  answer: string;
  /** 本轮是否有写操作被拦截（bot 据此追加确认卡） */
  pendingActions: PendingAction[];
}

/**
 * 飞书对话适配层：会话读写 DB、拼工具表，把「怎么问模型」全部委托给
 * LlmChatService.runToolLoop —— 本服务不实现循环，只做交易侧编排。
 *
 * 拦截规则（shouldIntercept）：
 * - tool.write === true（三个内置写工具）；
 * - tool.source === 'mcp'（外部工具安全默认）。
 * 拦截即存入 ConfirmationStore 并回「等待确认」的 tool 结果——LLM 循环内永不落地副作用。
 */
@Injectable()
export class FeishuAgentService {
  private readonly logger = new Logger(FeishuAgentService.name);

  constructor(
    private readonly chat: LlmChatService,
    private readonly skills: SkillLoaderService,
    private readonly mcp: McpToolSourceService,
    private readonly tradingTools: TradingToolsService,
    private readonly confirmation: ConfirmationStore,
    private readonly config: ConfigService,
    @InjectRepository(FeishuChatSessionEntity)
    private readonly sessionRepo: Repository<FeishuChatSessionEntity>,
  ) {}

  async ask(params: { tenantKey: string; chatId: string; openId: string; text: string }): Promise<AgentAskResult> {
    const { tenantKey, chatId, openId, text } = params;
    const session = await this.getOrCreateSession(tenantKey, chatId, openId);
    const history: ChatMessage[] = session.messages.map((m) => ({ role: m.role, content: m.content }));

    // 工具表：只读交易工具 + skills 元工具 + MCP 外部工具（每问重建一次，MCP 目录变更即时生效）
    const registry = new ToolRegistry();
    registry.registerAll(this.tradingTools.readTools());
    registry.registerAll(this.skills.toolDefs());
    try {
      registry.registerAll(await this.mcp.buildTools());
    } catch (err) {
      this.logger.warn(`MCP 工具装配失败（本轮仅平台内工具可用）：${(err as Error).message}`);
    }

    const system = buildBotSystemPrompt({
      now: Date.now(),
      env: (this.config.get<string>('BINANCE_ENV') as 'demo' | 'testnet' | 'live') || 'demo',
      runMode: this.config.get<string>('APP_RUN_MODE', 'dry_run'),
      skills: this.skills.listBriefs(),
    });

    const roundPending: PendingAction[] = [];
    const result = await this.chat.runToolLoop({
      userText: text,
      history,
      system,
      tools: registry,
      hooks: {
        onToolCall: (name, _args, ms, bytes) => {
          this.logger.log(`[bot ${chatId}] tool=${name} ${ms}ms ${bytes}B`);
        },
        shouldIntercept: (name, rawArgs) => {
          const tool = registry.get(name);
          if (!tool || (!tool.write && tool.source !== 'mcp')) return null;
          let args: Record<string, unknown> = {};
          try {
            args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
          } catch {
            return JSON.stringify({ error: 'invalid_arguments', detail: '参数不是合法 JSON' });
          }
          const action: PendingAction = { tool: name, args, label: describeAction(name, args) };
          roundPending.push(action);
          this.confirmation.push(chatId, action);
          return JSON.stringify({
            status: 'pending_confirmation',
            detail: `操作「${action.label}」已提交，等待用户在群里回复「确认」后执行。请告知用户确认流程，不要重复调用本工具。`,
          });
        },
      },
    });

    // 持久化：只存用户问题与最终回答（工具链不回存）
    const next: StoredChatMessage[] = [
      ...session.messages,
      { role: 'user', content: text, ts: Date.now() },
      { role: 'assistant', content: result.text, ts: Date.now() },
    ];
    session.messages = next.slice(-HISTORY_LIMIT);
    session.openId = openId || session.openId;
    await this.sessionRepo.save(session);

    return { answer: result.text, pendingActions: roundPending };
  }

  /** /new：清空会话历史 */
  async resetSession(tenantKey: string, chatId: string): Promise<void> {
    const session = await this.getOrCreateSession(tenantKey, chatId, '');
    session.messages = [];
    await this.sessionRepo.save(session);
  }

  private async getOrCreateSession(
    tenantKey: string,
    chatId: string,
    openId: string,
  ): Promise<FeishuChatSessionEntity> {
    const found = await this.sessionRepo.findOne({ where: { tenantKey, chatId } });
    if (found) return found;
    return this.sessionRepo.create({ tenantKey, chatId, openId, messages: [] as StoredChatMessage[] });
  }
}

/** 确认卡上展示的操作摘要 */
function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'stop_strategy':
      return args.instanceId ? `停止策略实例 ${String(args.instanceId)}（持仓保留）` : '停止全部策略实例（持仓保留）';
    case 'start_strategy':
      return `启动策略 ${args.name ?? '（平台默认）'} @ ${args.symbol ?? 'BTCUSDT'}`;
    case 'close_basket':
      return '一键平掉当前 OPEN 篮子（真实平仓，产生交易所单）';
    default:
      return `执行外部工具 ${name} ${JSON.stringify(args).slice(0, 120)}`;
  }
}
