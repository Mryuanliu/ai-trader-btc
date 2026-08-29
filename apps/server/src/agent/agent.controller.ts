import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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

/**
 * 配置更新 DTO。
 *
 * 字段必须完整覆盖前端可提交的项，否则启用 ValidationPipe 白名单后会被静默剥离。
 * 数值类字段做类型与范围校验，拦截非法输入；
 * 但风控参数的最终安全边界由 AgentConfigService 统一钳制，此处不重复定义上下限。
 */
class UpdateAgentConfigDto implements Partial<AgentConfigShape> {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  symbol?: string;

  @IsOptional()
  @IsString()
  timeframe?: AgentConfigShape['timeframe'];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(30)
  @Max(86_400)
  decisionIntervalSec?: number;

  @IsOptional()
  @IsString()
  mode?: AgentConfigShape['mode'];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledExchanges?: ExchangeCode[];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  positionPct?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  minConfidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(32_000)
  maxTokens?: number;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxOrderAmount?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxDailyOrders?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxDrawdownPct?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  minOrderIntervalSec?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  dailyLossLimit?: number;

  @IsOptional()
  @IsString()
  degradedAction?: AgentConfigShape['degradedAction'];

  /** 决策链路开关（hybrid 暂不接受，service 层归一为 llm） */
  @IsOptional()
  @IsIn(['llm', 'strategy', 'hybrid'])
  decisionLane?: AgentConfigShape['decisionLane'];

  /** 仅 llm 链路生效：LLM 失败后的行为 */
  @IsOptional()
  @IsIn(['hold', 'strategy', 'skip'])
  llmFailurePolicy?: AgentConfigShape['llmFailurePolicy'];

  /** strategy 链路使用的策略 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z][a-z0-9_]*$/)
  strategyName?: string;

  /** 策略专属参数 */
  @IsOptional()
  @IsObject()
  strategyParams?: Record<string, unknown>;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  slippageBps?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  feeRateBps?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxExposurePct?: number;
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
      health: this.engine.getHealth(),
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
      lane: entity.lane ?? 'llm',
      strategyName: entity.strategyName ?? null,
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
