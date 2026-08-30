import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 阶段 7 · 合约决策引擎。
 *
 * `agent_decisions` 增加 `market` 列（默认 'spot'，存量现货决策不受影响）。
 *
 * 隔离的必要性：现货与合约共用同一张决策表，若不区分市场，
 * 合约决策会混入现货决策列表与统计口径；更重要的是二者的持仓语义不可互换
 * （现货是成本均价 + 非负数量，合约是净持仓可为负 + 强平价），
 * 混在一起会让决策归因失去意义。
 */
export class FuturesEngine1700000007000 implements MigrationInterface {
  name = 'FuturesEngine1700000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "market" varchar(8) NOT NULL DEFAULT 'spot'`,
    );
    await queryRunner.query(
      `UPDATE "agent_decisions" SET "market" = 'spot' WHERE "market" IS NULL OR "market" = ''`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_market" ON "agent_decisions" ("market")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚前清除合约决策：去掉 market 列后无法再区分，留在表里会污染现货统计
    await queryRunner.query(`DELETE FROM "agent_decisions" WHERE "market" <> 'spot'`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_decisions_market"`);
    await queryRunner.query(
      `ALTER TABLE "agent_decisions" DROP COLUMN IF EXISTS "market"`,
    );
  }
}
