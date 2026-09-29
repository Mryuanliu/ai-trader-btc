import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RegisteredTool } from './llm-tools';

/**
 * MCP 工具来源（轻量挂接，不引任何 agent 框架）。
 *
 * env MCP_SERVERS 为 JSON 数组：
 *   [{ "name": "binance", "transport": "http", "url": "https://.../mcp", "enabled": true },
 *    { "name": "files",   "transport": "stdio", "command": "node", "args": ["server.js"] }]
 *
 * 启动时逐个 connect → listTools → 暴露为 RegisteredTool（命名 `<server>__<tool>` 防冲突）。
 * 连接失败只记日志、不阻塞启动。**安全默认：MCP 来源工具一律 write=true**，
 * 由上层 shouldIntercept 强制走确认流——外部工具的行为不受本仓库审计约束，宁可多一次确认。
 */
interface McpServerConfig {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
}

@Injectable()
export class McpToolSourceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpToolSourceService.name);
  private readonly clients = new Map<string, Client>();
  private configs: McpServerConfig[] = [];

  constructor(private readonly config: ConfigService) {}

  private parseConfigs(): McpServerConfig[] {
    const raw = this.config.get<string>('MCP_SERVERS', '');
    if (!raw || !raw.trim()) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error('MCP_SERVERS 必须是 JSON 数组');
      return arr.filter((c: McpServerConfig) => c && c.name && c.transport !== undefined && c.enabled !== false);
    } catch (err) {
      this.logger.error(`MCP_SERVERS 解析失败（本次启动忽略全部 MCP）：${(err as Error).message}`);
      return [];
    }
  }

  async onModuleInit(): Promise<void> {
    this.configs = this.parseConfigs();
    for (const cfg of this.configs) {
      try {
        const client = new Client({ name: 'tradedows-bot', version: '1.0.0' });
        const transport =
          cfg.transport === 'stdio'
            ? new StdioClientTransport({ command: cfg.command ?? '', args: cfg.args ?? [] })
            : new StreamableHTTPClientTransport(new URL(cfg.url ?? ''));
        await client.connect(transport);
        this.clients.set(cfg.name, client);
        this.logger.log(`MCP server「${cfg.name}」已连接`);
      } catch (err) {
        this.logger.warn(`MCP server「${cfg.name}」连接失败（跳过）：${(err as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
  }

  hasServers(): boolean {
    return this.configs.length > 0;
  }

  /** 每次构建会话工具表时调用：拉取各 server 的工具清单并包成执行器 */
  async buildTools(): Promise<RegisteredTool[]> {
    const out: RegisteredTool[] = [];
    for (const cfg of this.configs) {
      const client = this.clients.get(cfg.name);
      if (!client) continue;
      let tools;
      try {
        const res = await client.listTools();
        tools = res.tools ?? [];
      } catch (err) {
        this.logger.warn(`MCP server「${cfg.name}」listTools 失败：${(err as Error).message}`);
        continue;
      }
      const prefix = sanitize(cfg.name);
      for (const t of tools) {
        const toolName = `${prefix}__${sanitize(t.name)}`.slice(0, 64);
        out.push({
          def: {
            name: toolName,
            description: `[MCP:${cfg.name}] ${t.description || t.name}`.slice(0, 1024),
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          },
          exec: async (args) => {
            const res = await client.callTool({ name: t.name, arguments: args ?? {} });
            const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
            const text = content
              .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} 内容已省略]`))
              .join('\n');
            if ((res as { isError?: boolean }).isError) {
              return { error: 'mcp_tool_failed', detail: text.slice(0, 2000) };
            }
            return text.slice(0, 12_000) || '(空结果)';
          },
          // 安全默认：外部工具一律按写操作对待，走确认流
          write: true,
          source: 'mcp',
        });
      }
    }
    return out;
  }
}

/** OpenAI function name 只允许 [a-zA-Z0-9_-] */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
