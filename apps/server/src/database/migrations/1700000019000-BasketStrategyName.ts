import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 篮子归属到策略（绩效归因）。
 *
 * 背景：篮子是「一轮建仓 → 了结」的完整周期，天然是绩效计算单元；
 * 但它不带策略标识，导致只能算总账、无法回答「哪个策略赚了多少」——
 * 这是排行榜（P3）的前提。
 *
 * 存量数据回填为 'manual'（篮子功能上线以来的仓位多为手动/早期策略建立，
 * 无法可靠归因），新数据由 BasketService 写入真实策略名。
 */
export class BasketStrategyName1700000019000 implements MigrationInterface {
  name = 'BasketStrategyName1700000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "baskets" ADD COLUMN IF NOT EXISTS "strategyName" character varying(64) NOT NULL DEFAULT 'manual'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baskets_strategy" ON "baskets" ("strategyName")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baskets_strategy"`);
    await queryRunner.query(`ALTER TABLE "baskets" DROP COLUMN IF EXISTS "strategyName"`);
  }
}
