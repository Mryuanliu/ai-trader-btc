import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AgentConfigShape,
  AgentRuntimeState,
  DecisionAction,
  ExchangeCode,
  PageResult,
  DecisionSummary,
  DecisionRecord,
} from '@ai-trader/shared';
import { AgentEngine } from './agent-engine.service';
import { AgentConfigService } from './agent-config.service';
import { LlmClient } from './llm.client';
import { ExchangeAccountService } from '../exchanges/exchange-account.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';

class UpdateAgentConfigDto implements Partial<AgentConfigShape> {
  name?: string;
  enabled?: boolean;
  symbol?: string;
  timeframe?: AgentConfigShape['timeframe'];
  decisionIntervalSec?: number;
  mode?: AgentConfigShape['mode'];
  enabledExchanges?: ExchangeCode[];
  positionPct?: number;
  minConfidence?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  maxOrderAmount?: number;
  maxDailyOrders?: number;
  maxDrawdownPct?: number;
  minOrderIntervalSec?: number;
  dailyLossLimit?: number;
}

@Controller('agent')
export class AgentController {
  constructor(
    private readonly engine: AgentEngine,
    private readonly configService: AgentConfigService,
    private readonly llm: LlmClient,
    private readonly exchanges: ExchangeAccountService,
  ) {}

  /** Agent 配置 + 运行状态 */
  @Get('config')
  async getConfig(): Promise<AgentRuntimeState> {
    const config = await this.configService.get();
    const entity = await this.configService.getOrCreate();
    const accounts = await this.exchanges.list();

    return {
      config,
      running: this.engine.isRunning,
      lastRunAt: entity.lastRunAt ? entity.lastRunAt.toISOString() : null,
      lastDecisionId: entity.lastDecisionId,
      llmAvailable: this.llm.available,
      exchanges: accounts.map((a) => ({
        code: a.exchange,
        label: a.label,
        enabled: a.enabled,
        environment: a.environment,
        configured: a.configured,
        reachable: a.reachable,
        message: a.message,
      })),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('config')
  async updateConfig(@Body() dto: UpdateAgentConfigDto): Promise<AgentConfigShape> {
    return this.configService.update(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('toggle')
  async toggle(@Body() body: { enabled?: boolean }): Promise<AgentConfigShape> {
    return this.configService.setEnabled(body?.enabled !== false);
  }

  /** 手动触发一次决策 */
  @UseGuards(JwtAuthGuard)
  @Post('run')
  async run(): Promise<DecisionSummary> {
    if (this.engine.isRunning) {
      throw new BusinessException('AGENT_BUSY', 'Agent 正在决策中');
    }
    return this.engine.runOnce('manual');
  }

  @Get('decisions')
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('action') action?: DecisionAction,
    @Query('executedOnly') executedOnly?: string,
    @Query('keyword') keyword?: string,
  ): Promise<PageResult<DecisionSummary>> {
    return this.engine.list({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      action,
      executedOnly: executedOnly === 'true',
      keyword,
    });
  }

  /** 决策链条详情：行情 → 指标信号 → Prompt → 模型输出 → 风控 → 下单结果 */
  @Get('decisions/:id')
  async detail(@Param('id') id: string): Promise<DecisionRecord> {
    const entity = await this.engine.detail(id);
    if (!entity) throw new BusinessException('NOT_FOUND', '决策记录不存在');
    return {
      id: entity.id,
      agentId: entity.agentId,
      symbol: entity.symbol,
      action: entity.action,
      confidence: entity.confidence,
      reason: entity.reason,
      riskNotes: entity.riskNotes,
      inputSnapshot: entity.inputSnapshot,
      prompt: entity.prompt,
      llmRaw: entity.llmRaw,
      llmReasoning: entity.llmReasoning ?? null,
      llmModel: entity.llmModel ?? null,
      llmUsage: entity.llmUsage ?? null,
      degraded: entity.degraded,
      degradeReason: entity.degradeReason,
      risk: {
        passed: entity.riskPassed,
        rejectedBy: entity.riskRejectedBy ?? undefined,
        note: entity.riskNote ?? undefined,
      },
      orderId: entity.orderId,
      latencyMs: entity.latencyMs,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
