import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 移除「AI 直出买卖指令」链路（decisionLane='llm'）。
 *
 * 背景：AI 直接输出 BUY/SELL/HOLD 不可回测、不可复现、成本高且失败不可预测。
 * 移除后仅保留两条链路，且**两条链路的买卖都由确定性策略执行**：
 *   - strategy：纯策略，零 LLM 参与
 *   - hybrid：AI 仅提供市场上下文元参数，映射为策略参数后由策略执行
 *
 * 变更：
 * - agent_configs 删除 llmFailurePolicy 列（该字段仅服务于已移除的 llm 链路；
 *   hybrid 链路的 AI 失败由 TTL 缓存 + 中性默认参数兜底，不需要该字段）
 * - agent_configs 存量 decisionLane='llm' 修正为 'strategy'（策略执行，行为最接近）
 * - agent_decisions 存量 lane='llm' 的历史决策**保留不改**（历史真实性优先，前端兼容展示）
 */
export class DropLlmDecisionLane1700000005000 implements MigrationInterface {
  name = 'DropLlmDecisionLane1700000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量配置：'llm' 已无对应实现，落到 strategy（纯策略执行）以免引擎拿到无效链路
    await queryRunner.query(
      `UPDATE "agent_configs" SET "decisionLane" = 'strategy' WHERE "decisionLane" = 'llm'`,
    );

    // 删除仅服务于 llm 链路的字段
    await queryRunner.query(
      `ALTER TABLE "agent_configs" DROP COLUMN IF EXISTS "llmFailurePolicy"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚：恢复列，但无法还原每行的 llmFailurePolicy 原值（统一置为默认 'hold'）
    await queryRunner.query(
      `ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "llmFailurePolicy" varchar(16) DEFAULT 'hold'`,
    );
    // 注：decisionLane 由 'strategy' 改回 'llm' 会造成歧义（无法区分原本就是 strategy 的行），故不还原
  }
}
