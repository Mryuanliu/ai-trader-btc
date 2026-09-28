import { MigrationInterface, QueryRunner } from 'typeorm';

/** 订单记录策略运行实例（Lot 从订单继承，实现仓位隔离） */
export class OrderStrategyInstance1700000021000 implements MigrationInterface {
  name = 'OrderStrategyInstance1700000021000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "strategyInstanceId" character varying(128)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_instance" ON "orders" ("strategyInstanceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_instance"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "strategyInstanceId"`,
    );
  }
}
