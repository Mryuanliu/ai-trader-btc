import { Module } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { StrategyService } from './strategy.service';
import { DecisionCoreService } from './decision-core.service';

/**
 * 决策内核模块（L0~L3）：指标信号、策略插件、链路分派、AI 上下文。
 *
 * 仅合约模式下，唯一的消费者是 `FuturesEngine`（futures/futures.module.ts）。
 * 本模块不含任何执行/风控/持仓逻辑——那些属于 L4~L6，由各市场自己的链路实现。
 */
@Module({
  providers: [LlmClient, StrategyService, DecisionCoreService],
  // 导出决策内核：合约引擎复用这一份 L0~L3 实现
  exports: [LlmClient, StrategyService, DecisionCoreService],
})
export class AgentModule {}
