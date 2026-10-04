import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 回测闸门 v2（A6）新增留存列。
 *
 * 稳健性研究除 walk-forward/CPCV/DSR 外，新增 PBO、regime 分层、Monte Carlo 回撤分布，
 * sweep 新增参数高原掉幅；并记录结果所属撮合引擎版本（P1 event-driven v2 落地后用于
 * 「闸门只认新引擎定稿」的强制校验）。
 *
 * 全部可空：历史行保持 null，闸门对这些行按 `skip` 处理，不影响既有结论读取。
 * 开发环境 DB_SYNCHRONIZE=true 会先按实体建列，本迁移此时是 no-op。
 */
export class BacktestResearchV2170000024000 implements MigrationInterface {
  name = 'BacktestResearchV2170000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "pbo" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "mcMaxDDp95" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "plateauScore" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "cpcvQuantiles" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "regimeSummary" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "engineVersion" character varying(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "engineVersion"`);
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "regimeSummary"`);
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "cpcvQuantiles"`);
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "plateauScore"`);
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "mcMaxDDp95"`);
    await queryRunner.query(`ALTER TABLE "backtest_runs" DROP COLUMN IF EXISTS "pbo"`);
  }
}
