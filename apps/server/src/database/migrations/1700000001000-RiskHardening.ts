import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 交易链路加固：
 * - agent_configs 增加 key 唯一键（消除 getOrCreate 并发插入重复行的竞态）
 * - agent_configs 增加降级行为、滑点、费率三列
 * - balance_snapshots 补 (source, createdAt) 索引
 *   （初始迁移已在建表时声明，此处为存量库与索引被 synchronize 删除后的兜底）
 * - orders 补 (mode, status, createdAt) 索引
 *
 * 全部使用 IF NOT EXISTS，已在库上重复执行安全。
 */
export class RiskHardening1700000001000 implements MigrationInterface {
  name = 'RiskHardening1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // agent_configs.key：先加列并回填，再建唯一索引
    await queryRunner.query(`
      ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "key" varchar(32) DEFAULT 'default';
    `);
    await queryRunner.query(`
      UPDATE "agent_configs" SET "key" = 'default' WHERE "key" IS NULL OR "key" = '';
    `);

    // 若历史数据里存在多行，保留最早的一行，其余改 key 以免唯一索引创建失败
    await queryRunner.query(`
      UPDATE "agent_configs"
      SET "key" = 'legacy_' || LEFT("id"::text, 8)
      WHERE "id" NOT IN (
        SELECT "id" FROM "agent_configs" ORDER BY "createdAt" ASC LIMIT 1
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_agent_configs_key"
        ON "agent_configs" ("key");
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_configs"
        ADD COLUMN IF NOT EXISTS "degradedAction" varchar(16) DEFAULT 'hold',
        ADD COLUMN IF NOT EXISTS "slippageBps" float8 DEFAULT 5,
        ADD COLUMN IF NOT EXISTS "feeRateBps" float8 DEFAULT 10,
        ADD COLUMN IF NOT EXISTS "maxExposurePct" float8 DEFAULT 60;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_balance_snapshots_source"
        ON "balance_snapshots" ("source", "createdAt");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_mode_status_created"
        ON "orders" ("mode", "status", "createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_orders_mode_status_created";
      DROP INDEX IF EXISTS "IDX_balance_snapshots_source";
      DROP INDEX IF EXISTS "IDX_agent_configs_key";
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_configs"
        DROP COLUMN IF EXISTS "maxExposurePct",
        DROP COLUMN IF EXISTS "feeRateBps",
        DROP COLUMN IF EXISTS "slippageBps",
        DROP COLUMN IF EXISTS "degradedAction",
        DROP COLUMN IF EXISTS "key";
    `);
  }
}
