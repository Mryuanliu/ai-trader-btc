/**
 * LLM 工具层核心类型与注册表（通用对话/函数调用复用，不绑定任何 agent 框架）。
 *
 * 约定：
 * - def 是 OpenAI function-calling 的参数协议（喂给模型）；
 * - executor 是进程内真实执行器（模型不可见）；
 * - write=true 的工具**不允许在 LLM 循环内直接执行**，必须由上层
 *   （runToolLoop 的 shouldIntercept hook / 飞书 bot 的确认流）拦截后另行执行；
 * - source 标记来源，MCP 工具一律按 write 对待（安全默认）。
 */
import type { OpenAI } from 'openai';

export type ToolSourceKind = 'builtin' | 'skill' | 'mcp';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function parameters 格式） */
  parameters: Record<string, unknown>;
}

export type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export interface RegisteredTool {
  def: ToolDefinition;
  exec: ToolExecutor;
  /** true = 写操作/外部副作用：LLM 循环内不直接执行，走确认流 */
  write?: boolean;
  source?: ToolSourceKind;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.def.name)) {
      throw new Error(`工具重复注册：${tool.def.name}`);
    }
    this.tools.set(tool.def.name, tool);
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** 转 OpenAI SDK tools 参数（全部注册工具都暴露给模型） */
  toOpenAiTools(): OpenAI.Chat.ChatCompletionTool[] {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.def.name,
        description: t.def.description,
        parameters: t.def.parameters as OpenAI.Chat.ChatCompletionTool['function']['parameters'],
      },
    }));
  }
}
