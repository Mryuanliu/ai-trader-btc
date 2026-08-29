import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import { DecisionAction } from '@ai-trader/shared';
import { isTruthy } from '../common/env.util';

export const DecisionSchema = z.object({
  action: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  riskNotes: z.string().optional(),
});

export type LlmDecision = z.infer<typeof DecisionSchema> & { action: DecisionAction };

export interface LlmResult {
  ok: boolean;
  data?: LlmDecision;
  /** 模型正式回答（content） */
  raw: string | null;
  /**
   * 推理模型的思维链（reasoning_content）。
   * DeepSeek 的 deepseek-chat 会映射到推理模型，可能把正文留空、只回思维链，
   * 此时需要从思维链中兜底提取 JSON，同时把它展示在决策链条里。
   */
  reasoning?: string | null;
  /** 本次调用实际使用的模型名（别名会被服务端替换为真实模型） */
  model?: string | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  error?: string;
}

@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  private client: OpenAI | null = null;
  private cooldownUntil = 0;

  constructor(private readonly config: ConfigService) {}

  get available(): boolean {
    return (
      isTruthy(this.config.get('LLM_ENABLED'), true) &&
      Boolean(this.config.get<string>('LLM_API_KEY', ''))
    );
  }

  private getClient(): OpenAI | null {
    if (!this.available) return null;
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.config.get<string>('LLM_API_KEY', ''),
        baseURL: this.config.get<string>('LLM_BASE_URL', 'https://api.deepseek.com'),
        timeout: Number(this.config.get<string>('LLM_TIMEOUT_MS', '30000')),
        maxRetries: 1,
      });
    }
    return this.client;
  }

  async decide(system: string, user: string, model: string, temperature: number, maxTokens: number): Promise<LlmResult> {
    if (!this.available) {
      return { ok: false, raw: null, error: '未配置 LLM_API_KEY，已降级为纯指标策略' };
    }
    if (Date.now() < this.cooldownUntil) {
      return { ok: false, raw: null, error: '模型调用处于冷却期' };
    }

    const client = this.getClient();
    if (!client) return { ok: false, raw: null, error: '模型客户端初始化失败' };

    try {
      const completion = await client.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const message = completion.choices?.[0]?.message as unknown as Record<string, string>;
      const raw = message?.content ?? '';
      const reasoning = message?.reasoning_content ?? null;

      // 推理模型可能只回思维链而把正文留空，这里做兜底提取
      let parsed = this.parse(raw);
      let source: 'content' | 'reasoning' = 'content';
      if (!parsed && reasoning) {
        parsed = this.parse(reasoning);
        source = 'reasoning';
      }

      const usage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens ?? 0,
            completionTokens: completion.usage.completion_tokens ?? 0,
            totalTokens: completion.usage.total_tokens ?? 0,
          }
        : null;

      if (!parsed) {
        this.logger.warn(
          `模型输出无法解析，已降级：content=${raw.slice(0, 120)} reasoning=${(reasoning ?? '').slice(0, 120)}`,
        );
        return {
          ok: false,
          raw,
          reasoning,
          model: completion.model ?? model,
          usage,
          error: '模型输出不是合法 JSON 决策',
        };
      }

      this.logger.log(
        `模型裁决：${parsed.action} 置信度 ${parsed.confidence}（来源=${source}，模型=${completion.model ?? model}，tokens=${usage?.totalTokens ?? '-'}）`,
      );
      return {
        ok: true,
        data: parsed,
        raw,
        reasoning,
        model: completion.model ?? model,
        usage,
      };
    } catch (err) {
      // 失败后冷却 60s，避免每个决策周期都卡在超时上
      this.cooldownUntil = Date.now() + 60_000;
      const message = (err as Error).message;
      this.logger.warn(`模型调用失败，进入 60s 冷却：${message}`);
      return { ok: false, raw: null, error: message };
    }
  }

  /** 容错解析：直接 JSON.parse，失败则截取第一个 JSON 代码块 */
  private parse(raw: string): LlmDecision | null {
    if (!raw) return null;
    const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const candidates = [trimmed];
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) candidates.push(match[0]);

    for (const candidate of candidates) {
      try {
        const json = JSON.parse(candidate);
        const result = DecisionSchema.safeParse(json);
        if (result.success) return result.data as LlmDecision;
      } catch {
        /* 继续尝试下一个候选 */
      }
    }
    return null;
  }
}
