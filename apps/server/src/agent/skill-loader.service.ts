import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RegisteredTool } from './llm-tools';

/**
 * Agent Skills 加载器 —— 对齐 agentskills.io 开放标准（渐进披露）。
 *
 * 技能 = `<skillsDir>/<name>/SKILL.md`：frontmatter 至少含 name/description，
 * 正文是教模型做某类任务的固定体例/步骤。
 *
 * 三阶段在本实现的落点：
 * - 发现：listBriefs() 只出 name+description，由 prompts.ts 注入 system prompt；
 * - 激活：load_skill 元工具被模型调用时才读 SKILL.md 全文回喂；
 * - 执行：模型遵循正文指令继续调既有工具。**技能文件只读，本实现不执行其中任何脚本**。
 *
 * 目录解析：SKILLS_DIR 显式配置优先；否则依次探测源码态(src)与编译态(dist)旁挂目录
 * （nest build 默认会把非 ts 文件拷进 dist，dist/agent/skills 与 src/agent/skills 等价）。
 */
export interface SkillBrief {
  name: string;
  description: string;
}

interface ParsedSkill extends SkillBrief {
  dir: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);
  private readonly dir: string | null;

  constructor(config: ConfigService) {
    const explicit = config.get<string>('SKILLS_DIR', '');
    const candidates = explicit
      ? [explicit]
      : [join(__dirname, 'skills'), join(__dirname, '..', 'agent', 'skills')];
    this.dir = candidates.find((d) => existsSync(d)) ?? null;
    if (this.dir) this.logger.log(`Skills 目录：${this.dir}`);
  }

  /** 扫描全部合法技能（name 必须与目录名一致，防歧义） */
  private scan(): ParsedSkill[] {
    if (!this.dir) return [];
    const out: ParsedSkill[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(this.dir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
        const name = parsed?.meta.name;
        const description = parsed?.meta.description;
        if (!parsed || !name || !description || name !== entry.name) {
          this.logger.warn(`跳过技能 ${entry.name}：SKILL.md frontmatter 缺 name/description 或 name 与目录不一致`);
          continue;
        }
        out.push({ name, description, dir: join(this.dir, entry.name) });
      } catch (err) {
        this.logger.warn(`读取技能 ${entry.name} 失败：${(err as Error).message}`);
      }
    }
    return out;
  }

  listBriefs(): SkillBrief[] {
    return this.scan().map(({ name, description }) => ({ name, description }));
  }

  /** 读技能全文（仅限 skills 目录内，路径穿越防护） */
  readSkill(name: string): string {
    const skill = this.scan().find((s) => s.name === name);
    if (!skill) return `未找到技能：${name}。可用技能：${this.scan().map((s) => s.name).join(', ') || '（无）'}`;
    const root = this.dir as string;
    const file = join(skill.dir, 'SKILL.md');
    if (!file.startsWith(root)) throw new Error('非法技能路径');
    return readFileSync(file, 'utf8');
  }

  /** 挂进 ToolRegistry 的元工具（read 语义：只读文件，无副作用） */
  toolDefs(): RegisteredTool[] {
    return [
      {
        def: {
          name: 'load_skill',
          description:
            '按名称加载一个技能（SKILL.md 全文）作为回答该问题的专用体例/步骤。先用 list_skills 确认名称，禁止凭空模仿未加载的技能。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '技能名（与目录名一致）' },
            },
            required: ['name'],
          },
        },
        exec: async (args) => this.readSkill(String(args.name ?? '')),
        source: 'skill',
      },
      {
        def: {
          name: 'list_skills',
          description: '列出当前可用的全部技能（name + description）。',
          parameters: { type: 'object', properties: {} },
        },
        exec: async () => this.listBriefs(),
        source: 'skill',
      },
    ];
  }
}
