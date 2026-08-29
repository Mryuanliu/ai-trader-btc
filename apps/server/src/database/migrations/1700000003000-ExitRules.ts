import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 阶段 4 · 出场规则。
 * agent_configs 新增 exitRules jsonb 列（默认 {} = 止损/止盈全关，显式配置才启用），
 * 由 toShape() 读取时归一化兜底，存量行为零变化。
 */
export class ExitRules1700000003000 implements MigrationInterface {
  name = 'ExitRules1700000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "exitRules" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_configs" DROP COLUMN IF EXISTS "exitRules"`);
  }
}
