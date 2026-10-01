import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 合约配置表新增 `protections`（D4 平台侧熔断兜底）。
 *
 * 背景：平台首次引入风控类能力——运行实例连亏/回撤达阈时自动停实例（不平仓）。
 * 阈值随单行平台配置存放，沿用 `strategyRunParams` 的 jsonb 风格，避免堆多个标量列。
 *
 * 可空：历史行为 null，`toShape` 读到 null 回落 `DEFAULT_PROTECTIONS`（默认关），
 * 因此对既有行零影响——不加列默认值也不会破坏数据，熔断默认不干预。
 */
export class ProtectionsConfig1700000023000 implements MigrationInterface {
  name = 'ProtectionsConfig1700000023000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" ADD COLUMN IF NOT EXISTS "protections" jsonb NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "futures_agent_configs" DROP COLUMN IF EXISTS "protections"`,
    );
  }
}
