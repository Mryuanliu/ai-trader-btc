import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 双决策链路改造（阶段 0~2）：
 * - agent_configs 增加 decisionLane / llmFailurePolicy / strategyName / strategyParams 四列
 * - 存量 degradedAction='signal' 的行映射为 llmFailurePolicy='strategy'，
 *   让原「降级沿用兜底信号」的用户行为由新字段无缝承接
 * - agent_decisions 增加 lane / strategyName 两列并回填 'llm'（历史决策均来自 AI 链路）
 * - agent_decisions 增加 (lane, createdAt) 复合索引，便于按链路筛选归因
 *
 * 全部使用 IF NOT EXISTS，已在库上重复执行安全。
 */
export class DecisionLanes1700000002000 implements MigrationInterface {
  name = 'DecisionLanes1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // agent_configs 四列，默认值与实体定义严格一致
    await queryRunner.query(`
      ALTER TABLE "agent_configs"
        ADD COLUMN IF NOT EXISTS "decisionLane" varchar(16) DEFAULT 'llm',
        ADD COLUMN IF NOT EXISTS "llmFailurePolicy" varchar(16) DEFAULT 'hold',
        ADD COLUMN IF NOT EXISTS "strategyName" varchar(32) DEFAULT 'trend_following',
        ADD COLUMN IF NOT EXISTS "strategyParams" jsonb DEFAULT '{}'::jsonb;
    `);

    // 存量语义映射：原「降级沿用兜底信号」的用户由 llmFailurePolicy 无缝承接。
    // 加 IS NULL 条件避免重复执行时覆盖用户显式设置过的值。
    await queryRunner.query(`
      UPDATE "agent_configs"
      SET "llmFailurePolicy" = 'strategy'
      WHERE "degradedAction" = 'signal' AND "llmFailurePolicy" IS NULL;
    `);

    // agent_decisions 两列 + 回填历史决策（均来自 AI 链路）
    await queryRunner.query(`
      ALTER TABLE "agent_decisions"
        ADD COLUMN IF NOT EXISTS "lane" varchar(16) DEFAULT 'llm',
        ADD COLUMN IF NOT EXISTS "strategyName" varchar(32);
    `);
    await queryRunner.query(`
      UPDATE "agent_decisions" SET "lane" = 'llm' WHERE "lane" IS NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_lane_created"
        ON "agent_decisions" ("lane", "createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 注意：down 仅回滚 schema，不恢复 llmFailurePolicy → degradedAction 的语义映射
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_agent_decisions_lane_created";
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_decisions"
        DROP COLUMN IF EXISTS "strategyName",
        DROP COLUMN IF EXISTS "lane";
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_configs"
        DROP COLUMN IF EXISTS "strategyParams",
        DROP COLUMN IF EXISTS "strategyName",
        DROP COLUMN IF EXISTS "llmFailurePolicy",
        DROP COLUMN IF EXISTS "decisionLane";
    `);
  }
}
