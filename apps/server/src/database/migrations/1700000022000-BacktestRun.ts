import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 回测运行留存表（P0+）。
 *
 * 每次回测/研究/扫描落一行，保存完整结果 JSON + 摘要列，供前端「回测台 · 历史」回看对比。
 * 数值列用 double precision：epoch 毫秒与各项比率都能作为 JS number 直取。
 *
 * 全部 IF NOT EXISTS：开发环境 DB_SYNCHRONIZE=true 时会先按实体建好表，
 * 本迁移此时应是 no-op；生产（关同步）则靠这里建表。
 */
export class BacktestRun1700000022000 implements MigrationInterface {
  name = 'BacktestRun1700000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "backtest_runs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "label" character varying(128),
        "kind" character varying(16) NOT NULL,
        "strategyName" character varying(64) NOT NULL,
        "symbol" character varying(20) NOT NULL,
        "interval" character varying(8) NOT NULL,
        "from" double precision NOT NULL,
        "to" double precision NOT NULL,
        "initialCapital" double precision NOT NULL,
        "report" jsonb NOT NULL,
        "totalReturnPct" double precision,
        "sharpe" double precision,
        "oosSharpe" double precision,
        "dsr" double precision
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_backtest_runs_created_at" ON "backtest_runs" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_backtest_runs_strategy_symbol" ON "backtest_runs" ("strategyName", "symbol")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_backtest_runs_strategy_symbol"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_backtest_runs_created_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "backtest_runs"`);
  }
}
