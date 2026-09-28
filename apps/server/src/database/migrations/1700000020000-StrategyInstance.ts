import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 多实例支持（P2）：
 * 1. 新增 `strategy_instances` 表 —— 运行意图持久化 + 实例标识
 * 2. `position_lots` / `baskets` 加 `strategyInstanceId` —— 仓位与篮子的实例归属
 *
 * 为什么必须有第 2 点：不隔离的话，两个运行实例都会把「该交易对的全部 Lot」
 * 当成自己的篮子，结果是互相加层、互相平掉对方的仓——属于致命错误。
 *
 * 存量数据：`strategyInstanceId` 留空（历史仓位无法可靠归因到实例），
 * 由运行器按 legacy 实例接管。
 */
export class StrategyInstance1700000020000 implements MigrationInterface {
  name = 'StrategyInstance1700000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "strategy_instances" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "instanceId" character varying(128) NOT NULL,
        "strategyName" character varying(64) NOT NULL,
        "symbol" character varying(20) NOT NULL,
        "params" jsonb,
        "shouldRun" boolean NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_strategy_instances_key" ON "strategy_instances" ("instanceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_strategy_instances_should_run" ON "strategy_instances" ("shouldRun")`,
    );

    await queryRunner.query(
      `ALTER TABLE "position_lots" ADD COLUMN IF NOT EXISTS "strategyInstanceId" character varying(128)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lots_instance" ON "position_lots" ("strategyInstanceId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "baskets" ADD COLUMN IF NOT EXISTS "strategyInstanceId" character varying(128)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baskets_instance" ON "baskets" ("strategyInstanceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baskets_instance"`);
    await queryRunner.query(
      `ALTER TABLE "baskets" DROP COLUMN IF EXISTS "strategyInstanceId"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lots_instance"`);
    await queryRunner.query(
      `ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "strategyInstanceId"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_strategy_instances_should_run"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_strategy_instances_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "strategy_instances"`);
  }
}
