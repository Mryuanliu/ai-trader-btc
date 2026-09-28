import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 策略运行意图持久化：服务重启后自动恢复挂载。
 *
 * 背景：策略运行状态只在内存（StrategyRunner.current），重启即丢；
 * 而持仓单在数据库/交易所里还在——结果就是「界面显示未运行、账户却挂着仓位」，
 * 用户会以为策略自己停了。把「重启前在跑」这个事实落库，
 * 服务启动时读到 true 就自动重新挂载并接管未平仓。
 */
export class StrategyAutostart1700000018000 implements MigrationInterface {
  name = 'StrategyAutostart1700000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" ADD COLUMN IF NOT EXISTS "strategyShouldRun" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" ADD COLUMN IF NOT EXISTS "strategyRunName" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" ADD COLUMN IF NOT EXISTS "strategyRunParams" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" DROP COLUMN IF EXISTS "strategyRunParams"`,
    );
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" DROP COLUMN IF EXISTS "strategyRunName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" DROP COLUMN IF EXISTS "strategyShouldRun"`,
    );
  }
}
