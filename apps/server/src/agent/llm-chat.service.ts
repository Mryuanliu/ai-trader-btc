import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { LlmClient } from './llm.client';
import { ToolRegistry } from './llm-tools';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（可能非法，由调用方 safeParse） */
  args: string;
}

export interface LoopHooks {
  /** 每次工具执行后回调（可观测：名称/参数/耗时/结果字节） */
  onToolCall?(name: string, args: ToolCall['args'], durationMs: number, resultBytes: number): void;
  /**
   * 写操作拦截：返回非 null 表示**不执行工具**，返回值作为 tool 结果回喂模型
   * （典型场景：存 pendingAction 后返回「已提交确认，等待用户回复确认」）。
   */
  shouldIntercept?(name: string, args: ToolCall['args']): Promise<string | null> | string | null;
  /** 全部原始消息（含 assistant/tool），供上层持久化会话 */
  onMessages?(messages: OpenAI.Chat.ChatCompletionMessageParam[]): void;
  onFinal?(text: string): void;
}

export interface ToolLoopResult {
  text: string;
  rounds: number;
  usage: TokenUsage | null;
}

/** 估算 token：中英混合按 ~3 字符/token，粗算仅用于历史截断预算 */
function estTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

function msgText(m: { content?: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

/**
 * 通用对话核心：多轮文本 + OpenAI function-calling 工具循环。
 *
 * 与 LlmClient.analyzeContext（AI 行情单发 JSON）共享底层 client、互不影响；
 * 飞书机器人是第一个消费方，Web 端聊天将来复用同一套。
 *
 * 韧性设计：
 * - 429/5xx/网络错 → 指数退避重试 2 次（500ms/2s）；硬失败进入 60s 冷却（共享）
 * - 历史按 LLM_CHAT_TOKEN_BUDGET 截断（保 system + 最近 N 条，从最老丢）
 * - 循环上限 LLM_MAX_TOOL_ROUNDS，达上限用兜底话术而不是死磕
 * - DeepSeek 别名会被静默替换（deepseek-chat→deepseek-flash）且 reasoning_content
 *   可能消失：解析/日志一律以响应 model 为准，不依赖思维链字段。
 */
@Injectable()
export class LlmChatService {
  private readonly logger = new Logger(LlmChatService.name);
  private cooldownUntil = 0;

  constructor(
    private readonly llm: LlmClient,
    private readonly config: ConfigService,
  ) {}

  private get client(): OpenAI | null {
    return this.llm.sharedClient;
  }

  available(): boolean {
    return this.llm.available;
  }

  private baseOpts(opts: ChatOpts) {
    return {
      model: opts.model ?? this.config.get<string>('LLM_CHAT_MODEL') ?? this.config.get<string>('LLM_MODEL', 'deepseek-chat'),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2000,
      timeout: Number(this.config.get<string>('LLM_CHAT_TIMEOUT_MS', '45000')),
    };
  }

  /** 单轮纯文本对话（不带工具） */
  async chatOnce(messages: ChatMessage[], opts: ChatOpts = {}): Promise<{ text: string; usage: TokenUsage | null }> {
    const base = this.baseOpts(opts);
    const res = await this.createWithRetry(
      { ...base, messages: this.truncateHistory(messages) },
      'chatOnce',
    );
    const text = (res.choices?.[0]?.message?.content as string) ?? '';
    return { text, usage: this.mapUsage(res) };
  }

  /** 单轮带工具调用：返回 content 或 tool_calls（不执行工具） */
  async chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.ChatCompletionTool[],
    opts: ChatOpts = {},
  ): Promise<{ message: OpenAI.Chat.ChatCompletionMessage; usage: TokenUsage | null }> {
    const base = this.baseOpts(opts);
    const res = await this.createWithRetry(
      { ...base, messages: this.truncateParams(messages), tools, tool_choice: 'auto' as const },
      'chatWithTools',
    );
    const message = res.choices?.[0]?.message;
    if (!message) throw new Error('LLM 返回为空');
    return { message, usage: this.mapUsage(res) };
  }

  /**
   * 完整 agentic 循环：拼 system + 截断历史 + 用户消息 → 带工具调用 →
   * 按 tool_call_id 执行回喂 → 直到模型不再调工具或达 maxRounds。
   * 写工具经 shouldIntercept 拦截，循环内永不直接执行。
   */
  async runToolLoop(params: {
    userText: string;
    history?: ChatMessage[];
    system?: string;
    tools: ToolRegistry;
    hooks?: LoopHooks;
    maxRounds?: number;
    model?: string;
  }): Promise<ToolLoopResult> {
    const { userText, tools, hooks } = params;
    const maxRounds = params.maxRounds ?? Number(this.config.get<string>('LLM_MAX_TOOL_ROUNDS', '6'));
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (params.system) messages.push({ role: 'system', content: params.system });
    // 历史截断预算：预留 system + 本轮用户消息 + 一定余量
    messages.push(...this.truncateHistory(params.history ?? [], 6000));
    messages.push({ role: 'user', content: userText });

    const openAiTools = tools.toOpenAiTools();
    let totalUsage: TokenUsage | null = null;
    let rounds = 0;

    while (rounds < maxRounds) {
      rounds += 1;
      const { message, usage } = await this.chatWithTools(
        messages,
        openAiTools,
        { model: params.model },
      );
      if (usage) totalUsage = this.mergeUsage(totalUsage, usage);
      messages.push(this.toParam(message));
      hooks?.onMessages?.(messages);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        const text = (message.content as string) || '（模型未返回内容）';
        hooks?.onFinal?.(text);
        return { text, rounds, usage: totalUsage };
      }

      for (const call of calls) {
        if (call.type !== 'function') continue;
        const name = call.function.name;
        const rawArgs = call.function.arguments ?? '{}';
        let toolResult: string;
        const startedAt = Date.now();
        try {
          const parsed: { value?: Record<string, unknown>; error?: string } = (() => {
            try {
              return { value: this.parseArgsObject(rawArgs) };
            } catch (e) {
              return { error: (e as Error).message };
            }
          })();
          if (parsed.error || !parsed.value) {
            // 非法参数：结构化错误回喂，让模型自修正（最多浪费 1 轮）
            toolResult = JSON.stringify({ error: 'invalid_arguments', detail: parsed.error ?? '参数解析失败' });
          } else {
            const tool = tools.get(name);
            if (!tool) {
              toolResult = JSON.stringify({ error: 'unknown_tool', detail: `未注册工具：${name}` });
            } else {
              const intercept = (await hooks?.shouldIntercept?.(name, rawArgs)) ?? null;
              if (intercept !== null) {
                toolResult = intercept;
              } else {
                const out = await tool.exec(parsed.value);
                toolResult = typeof out === 'string' ? out : JSON.stringify(out);
              }
            }
          }
        } catch (err) {
          toolResult = JSON.stringify({ error: 'tool_execution_failed', detail: (err as Error).message });
        }
        hooks?.onToolCall?.(name, rawArgs, Date.now() - startedAt, Buffer.byteLength(toolResult, 'utf8'));
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult.slice(0, 12_000) });
      }
      hooks?.onMessages?.(messages);
    }

    const fallback = '这个问题我需要更多步骤才能查清数据，请换个更具体的问法（比如限定时间范围或标的）。';
    hooks?.onFinal?.(fallback);
    return { text: fallback, rounds, usage: totalUsage };
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 429/5xx/网络错指数退避重试 2 次；重试仍失败 → 60s 冷却并抛出 */
  private async createWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    tag: string,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const client = this.client;
    if (!client) throw new Error('未配置 LLM_API_KEY，对话能力不可用');
    if (Date.now() < this.cooldownUntil) throw new Error('模型调用处于冷却期，请稍后再试');
    const backoffs = [500, 2000];
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
      try {
        const res = await client.chat.completions.create(request);
        return res;
      } catch (err) {
        lastErr = err as Error;
        const status = (err as { status?: number }).status ?? 0;
        const retryable =
          status === 429 || status >= 500 || /timeout|ECONN|ETIMEDOUT|socket hang up/i.test(lastErr.message);
        if (!retryable || attempt === backoffs.length) break;
        this.logger.warn(`[${tag}] 第 ${attempt + 1} 次调用失败(${status || lastErr.message})，${backoffs[attempt]}ms 后重试`);
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
    }
    this.cooldownUntil = Date.now() + 60_000;
    this.logger.warn(`[${tag}] 调用失败，进入 60s 冷却：${lastErr?.message}`);
    throw lastErr ?? new Error('LLM 调用失败');
  }

  /** 解析工具参数：必须是 JSON 对象，否则抛错（调用方把错误信息回喂模型自修正） */
  private parseArgsObject(raw: string): Record<string, unknown> {
    if (!raw || !raw.trim()) return {};
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch (err) {
      throw new Error(`JSON 解析失败：${(err as Error).message}`);
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('参数必须是 JSON 对象');
    }
    return v as Record<string, unknown>;
  }

  /** 按 token 预算从最老开始丢弃历史；system 消息与最后一条永不丢 */
  private truncateHistory<T extends { role: string; content: string }>(history: T[], budget = 8000): T[] {
    if (history.length <= 2) return history;
    let total = history.reduce((sum, m) => sum + estTokens(msgText(m)) + 4, 0);
    const out = [...history];
    while (total > budget && out.length > 2) {
      // 从最老的非 system 消息丢起
      const idx = out.findIndex((m) => m.role !== 'system');
      if (idx < 0 || idx === out.length - 1) break;
      total -= estTokens(msgText(out[idx])) + 4;
      out.splice(idx, 1);
    }
    return out;
  }

  /** OpenAI 原始消息列表版的历史截断（含 tool_calls 的消息原样保留） */
  private truncateParams(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    budget = 8000,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (messages.length <= 2) return messages;
    let total = messages.reduce((sum, m) => sum + estTokens(msgText(m)) + 4, 0);
    const out = [...messages];
    while (total > budget && out.length > 2) {
      const idx = out.findIndex((m) => m.role !== 'system');
      if (idx < 0 || idx === out.length - 1) break;
      total -= estTokens(msgText(out[idx])) + 4;
      out.splice(idx, 1);
    }
    return out;
  }

  /** assistant 响应对象 → 可回喂的 ChatCompletionMessageParam */
  private toParam(m: OpenAI.Chat.ChatCompletionMessage): OpenAI.Chat.ChatCompletionMessageParam {
    const param: OpenAI.Chat.ChatCompletionMessageParam = {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : null,
    };
    if (m.tool_calls && m.tool_calls.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (param as any).tool_calls = m.tool_calls;
    }
    return param;
  }

  private mapUsage(res: OpenAI.Chat.ChatCompletion): TokenUsage | null {
    const u = res.usage;
    if (!u) return null;
    return {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    };
  }

  private mergeUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
    if (!a) return b;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }
}
