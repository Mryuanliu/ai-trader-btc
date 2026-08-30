import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 阶段 6 · 合约交易能力。
 *
 * - `orders` 增加合约维度列：`market`（默认 'spot'，存量现货单不受影响）、
 *   `leverage`、`positionSide`、`reduceOnly`。
 *   没有 `market` 列就无法区分现货单与合约单，而二者持仓口径完全不同
 *   （现货由成交明细推导，合约以交易所 positionRisk 为权威），混算会直接污染现货持仓。
 * - 新建 `futures_agent_configs`：合约链路独立配置（独立开关/策略/杠杆/保证金模式）。
 *
 * 幂等性：本地 DB_SYNCHRONIZE=true 时表结构可能已由 synchronize 建好，全部语句使用 IF NOT EXISTS。
 */
export class FuturesTrading1700000006000 implements MigrationInterface {
  name = 'FuturesTrading1700000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "market" varchar(8) NOT NULL DEFAULT 'spot'`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "leverage" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "positionSide" varchar(8)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "reduceOnly" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "futures_agent_configs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" varchar(32) NOT NULL DEFAULT 'default',
        "name" varchar(64) NOT NULL DEFAULT 'BTC 合约 Agent',
        "enabled" boolean NOT NULL DEFAULT true,
        "symbol" varchar(32) NOT NULL DEFAULT 'BTCUSDT',
        "timeframe" varchar(8) NOT NULL DEFAULT '5m',
        "decisionIntervalSec" integer NOT NULL DEFAULT 300,
        "mode" varchar(16) NOT NULL DEFAULT 'dry_run',
        "positionPct" double precision NOT NULL DEFAULT 0.1,
        "minConfidence" double precision NOT NULL DEFAULT 0.6,
        "leverage" integer NOT NULL DEFAULT 5,
        "maxLeverage" integer NOT NULL DEFAULT 10,
        "marginType" varchar(16) NOT NULL DEFAULT 'isolated',
        "liquidationBufferPct" double precision NOT NULL DEFAULT 0.15,
        "decisionLane" varchar(16) NOT NULL DEFAULT 'hybrid',
        "strategyName" varchar(32) NOT NULL DEFAULT 'trend_following',
        "strategyParams" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "exitRules" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "lastRunAt" timestamptz,
        "lastDecisionId" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_futures_agent_configs_key"
        ON "futures_agent_configs" ("key");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "futures_agent_configs"`);
    // 回滚前清除合约单：去掉 market 列后无法再区分，留在表里会污染现货持仓统计
    await queryRunner.query(`DELETE FROM "orders" WHERE "market" <> 'spot'`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "reduceOnly"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "positionSide"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "leverage"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "market"`);
  }
}
