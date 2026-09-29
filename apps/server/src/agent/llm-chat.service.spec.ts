import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { LlmClient } from './llm.client';
import { LlmChatService } from './llm-chat.service';
import { RegisteredTool, ToolRegistry } from './llm-tools';

/** 用假 OpenAI client 驱动 LlmChatService：create 依次吐出预设响应 */
function build(createImpl: ReturnType<typeof vi.fn>) {
  const fakeClient = { chat: { completions: { create: createImpl } } };
  const llm = {
    available: true,
    sharedClient: fakeClient,
  } as unknown as LlmClient;
  const store: Record<string, unknown> = {
    LLM_CHAT_MODEL: 'deepseek-chat',
    LLM_CHAT_TIMEOUT_MS: '45000',
    LLM_MAX_TOOL_ROUNDS: '6',
  };
  const config = { get: (k: string, d?: string) => store[k] ?? d } as unknown as ConfigService;
  return new LlmChatService(llm, config);
}

function textResp(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolResp(calls: Array<{ id: string; name: string; args: string }>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function registryWith(tools: RegisteredTool[]) {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe('LlmChatService.runToolLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('两轮收敛：先调工具再出最终答案，tool 结果按 tool_call_id 回喂', async () => {
    const exec = vi.fn().mockResolvedValue({ net: 12.3 });
    const tools = registryWith([{ def: { name: 'get_pnl_summary', description: 'd', parameters: {} }, exec }]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResp([{ id: 'c1', name: 'get_pnl_summary', args: '{"period":"today"}' }]))
      .mockResolvedValueOnce(textResp('今日净盈亏 12.3 USDT'));
    const svc = build(create);

    const seen: string[] = [];
    const res = await svc.runToolLoop({
      userText: '今天赚了多少',
      tools,
      hooks: { onToolCall: (n) => seen.push(n) },
    });

    expect(res.text).toBe('今日净盈亏 12.3 USDT');
    expect(res.rounds).toBe(2);
    expect(exec).toHaveBeenCalledWith({ period: 'today' });
    expect(seen).toEqual(['get_pnl_summary']);
    // 第二次请求 messages 里应含 tool 角色回喂
    const second = create.mock.calls[1][0] as { messages: Array<{ role: string; tool_call_id?: string }> };
    expect(second.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);
  });

  it('写工具被 shouldIntercept 拦截：exec 不被调用，拦截文案作为 tool 结果回喂', async () => {
    const exec = vi.fn();
    const tools = registryWith([{ def: { name: 'stop_strategy', description: 'd', parameters: {} }, exec, write: true }]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResp([{ id: 'w1', name: 'stop_strategy', args: '{}' }]))
      .mockResolvedValueOnce(textResp('已提交确认，请回复确认'));
    const svc = build(create);

    const res = await svc.runToolLoop({
      userText: '停掉策略',
      tools,
      hooks: { shouldIntercept: (name) => (name === 'stop_strategy' ? JSON.stringify({ status: 'pending_confirmation' }) : null) },
    });

    expect(exec).not.toHaveBeenCalled();
    expect(res.text).toContain('已提交确认');
    const second = create.mock.calls[1][0] as { messages: Array<{ role: string; content?: string }> };
    expect(second.messages.some((m) => m.role === 'tool' && m.content?.includes('pending_confirmation'))).toBe(true);
  });

  it('非法 JSON 参数不执行工具，结构化错误回喂自修正', async () => {
    const exec = vi.fn();
    const tools = registryWith([{ def: { name: 't', description: 'd', parameters: {} }, exec }]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResp([{ id: 'b1', name: 't', args: '{bad json' }]))
      .mockResolvedValueOnce(textResp('ok'));
    const svc = build(create);
    const res = await svc.runToolLoop({ userText: 'q', tools });
    expect(exec).not.toHaveBeenCalled();
    expect(res.text).toBe('ok');
    const second = create.mock.calls[1][0] as { messages: Array<{ content?: string }> };
    expect(second.messages.some((m) => m.content?.includes('invalid_arguments'))).toBe(true);
  });

  it('达 maxRounds 上限返回兜底话术', async () => {
    const tools = registryWith([
      { def: { name: 't', description: 'd', parameters: {} }, exec: vi.fn().mockResolvedValue('r') },
    ]);
    let i = 0;
    const create = vi.fn().mockImplementation(() => {
      i += 1;
      return Promise.resolve(toolResp([{ id: `c${i}`, name: 't', args: '{}' }]));
    });
    const svc = build(create);
    const res = await svc.runToolLoop({ userText: 'q', tools, maxRounds: 3 });
    expect(res.rounds).toBe(3);
    expect(res.text).toContain('请换个更具体的问法');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('429 指数退避重试两次后成功', async () => {
    const httpErr = Object.assign(new Error('rate limit'), { status: 429 });
    const create = vi.fn().mockRejectedValueOnce(httpErr).mockRejectedValueOnce(httpErr).mockResolvedValueOnce(textResp('done'));
    const svc = build(create);
    const res = await svc.chatOnce([{ role: 'user', content: 'hi' }]);
    expect(res.text).toBe('done');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('重试耗尽进入冷却：后续调用直接抛冷却错误', async () => {
    const httpErr = Object.assign(new Error('boom'), { status: 503 });
    const create = vi.fn().mockRejectedValue(httpErr);
    const svc = build(create);
    await expect(svc.chatOnce([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    // 冷却期内不再发出新请求
    const before = create.mock.calls.length;
    await expect(svc.chatOnce([{ role: 'user', content: 'hi' }])).rejects.toThrow(/冷却/);
    expect(create.mock.calls.length).toBe(before);
  });

  it('历史按预算截断：超长最老消息被丢弃，system 与最新保留', async () => {
    const create = vi.fn().mockResolvedValue(textResp('ok'));
    const svc = build(create);
    const long = 'x'.repeat(30000);
    const history = [
      { role: 'user' as const, content: long },
      { role: 'assistant' as const, content: long },
      { role: 'user' as const, content: '短问题' },
    ];
    await svc.runToolLoop({ userText: '追问', history, system: 'SYS', tools: registryWith([]) });
    const req = create.mock.calls[0][0] as { messages: Array<{ role: string; content?: unknown }> };
    expect(req.messages[0].role).toBe('system');
    expect(req.messages.some((m) => typeof m.content === 'string' && m.content === long)).toBe(false);
    expect(req.messages[req.messages.length - 1].content).toBe('追问');
  });
});
