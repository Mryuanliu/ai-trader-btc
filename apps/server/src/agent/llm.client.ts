import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import { ContextInsight } from '@ai-trader/shared';
import { isTruthy } from '../common/env.util';

/**
 * AI 上下文分析输出（元参数，非买卖指令）。
 * 注：原让模型直出 BUY/SELL/HOLD 的 DecisionSchema 已移除——
 * AI 不再下达买卖指令，只提供市场上下文，由策略执行（分层裁决）。
 */
export const ContextInsightSchema = z.object({
  regime: z.enum(['trending', 'ranging', 'volatile']),
  regimeConfidence: z.number().min(0).max(1),
  aggression: z.number().min(0).max(1),
  newsSentiment: z.number().min(-1).max(1),
  positionView: z.enum(['positive', 'neutral', 'negative']),
  // 建议止盈止损（Lot 模型逐单出场参数），可选：不输出则用全局兜底
  suggestedStopLossPct: z.number().min(0.005).max(0.1).optional(),
  suggestedTakeProfitPct: z.number().min(0.005).max(0.1).optional(),
  comment: z.string().max(120).optional(),
});

export interface LlmResult {
  ok: boolean;
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

  /**
   * hybrid 链路：让模型输出市场上下文元参数（非买卖指令）。
   * AI 不输出 BUY/SELL，只输出 regime/aggression/情绪等元参数，由策略执行买卖。
   * 解析失败按 ok=false 处理，调用方回落到中性默认参数，策略继续运行。
   */
  async analyzeContext(
    system: string,
    user: string,
    model: string,
    temperature: number,
    maxTokens: number,
  ): Promise<LlmResult & { data?: never; insight?: ContextInsight }> {
    const base = { ok: false, raw: null as string | null };
    if (!this.available) return { ...base, error: '未配置 LLM_API_KEY' };
    if (Date.now() < this.cooldownUntil) {
      return { ...base, error: '模型调用处于冷却期' };
    }
    const client = this.getClient();
    if (!client) return { ...base, error: '模型客户端初始化失败' };

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
      const usage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens ?? 0,
            completionTokens: completion.usage.completion_tokens ?? 0,
            totalTokens: completion.usage.total_tokens ?? 0,
          }
        : null;
      const insight = this.parseInsight(raw) ?? (reasoning ? this.parseInsight(reasoning) : null);
      if (!insight) {
        this.logger.warn(`上下文输出无法解析：content=${raw.slice(0, 120)}`);
        return { ok: false, raw, reasoning, model: completion.model ?? model, usage, error: '模型输出不是合法 JSON 上下文' };
      }
      this.logger.log(
        `上下文分析：regime=${insight.regime}(${insight.regimeConfidence}) 激进度=${insight.aggression} 情绪=${insight.newsSentiment}（tokens=${usage?.totalTokens ?? '-'}）`,
      );
      return { ok: true, raw, reasoning, model: completion.model ?? model, usage, insight };
    } catch (err) {
      this.cooldownUntil = Date.now() + 60_000;
      const msg = (err as Error).message;
      this.logger.warn(`上下文调用失败，进入 60s 冷却：${msg}`);
      return { ok: false, raw: null, error: msg };
    }
  }

  private parseInsight(raw: string): ContextInsight | null {
    if (!raw) return null;
    const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const candidates = [trimmed];
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) candidates.push(match[0]);
    for (const candidate of candidates) {
      try {
        const json = JSON.parse(candidate);
        const result = ContextInsightSchema.safeParse(json);
        if (result.success) return result.data as ContextInsight;
      } catch {
        /* 继续尝试下一个候选 */
      }
    }
    return null;
  }
}
