import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 篮子（Basket）：把「一次建仓 → 全部了结」的周期显式化。
 *
 * 背景：马丁网格加层时，中间层必然是浮亏的，单看某一笔订单的盈亏没有意义——
 * 只有把整轮一起算，才知道这一个循环到底赚没赚。
 * 所以给每一轮建仓发一个编号，把该轮所有仓位单（Lot）挂到篮子下，
 * 出场时汇总出「整体盈亏」。
 *
 * 存量数据处理：
 * - 现存 **OPEN** 的 Lot 回填到一个按 symbol 生成的占位篮子，
 *   保证当前持仓也有篮子可归属（否则总览里会看到一堆「未归档」）。
 * - 已 CLOSED 的历史 Lot 不回填：它们已了结，篮子的价值在于跟踪与复盘当前轮次，
 *   而早期数据无法可靠地还原「哪些单属于同一轮」（缺少加层时间间隔等依据）。
 */
export class Basket1700000016000 implements MigrationInterface {
  name = 'Basket1700000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 全部用 IF NOT EXISTS：开发环境 `DB_SYNCHRONIZE=true` 时 TypeORM 会先按实体建好表，
    // 那时再跑本迁移不该报错（42P07），而生产（关闭同步）则靠这里建表。
    // ---- 1. 篮子表 ----
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "baskets" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" character varying(32) NOT NULL,
        "market" character varying(16) NOT NULL,
        "symbol" character varying(20) NOT NULL,
        "direction" character varying(8) NOT NULL,
        "origin" character varying(16) NOT NULL DEFAULT 'manual',
        "status" character varying(16) NOT NULL,
        "layerCount" integer NOT NULL DEFAULT 0,
        "totalQuantity" numeric(28,10) NOT NULL DEFAULT 0,
        "avgEntryPrice" numeric(28,10) NOT NULL DEFAULT 0,
        "closedQuantity" numeric(28,10) NOT NULL DEFAULT 0,
        "avgExitPrice" numeric(28,10),
        "feeTotal" numeric(28,10) NOT NULL DEFAULT 0,
        "realizedPnl" numeric(28,10) NOT NULL DEFAULT 0,
        "returnPct" numeric(14,8),
        "exitReason" character varying(24),
        "openedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "closedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_baskets_code" ON "baskets" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baskets_market_symbol_status" ON "baskets" ("market", "symbol", "status")`,
    );

    // ---- 2. Lot 关联篮子 ----
    await queryRunner.query(`ALTER TABLE "position_lots" ADD COLUMN IF NOT EXISTS "basketId" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lots_basket" ON "position_lots" ("basketId")`,
    );

    // ---- 3. 存量回填：现存 OPEN Lot 各归入一个按 symbol 的占位篮子 ----
    await queryRunner.query(`
      INSERT INTO "baskets"
        ("code", "market", "symbol", "direction", "origin", "status",
         "layerCount", "totalQuantity", "avgEntryPrice", "closedQuantity",
         "feeTotal", "realizedPnl", "openedAt")
      SELECT
        'BK-LEGACY-' || upper(substring(md5(random()::text) from 1 for 6)),
        l."market",
        l."symbol",
        CASE WHEN count(DISTINCT l."direction") > 1 THEN 'MIXED' ELSE min(l."direction") END,
        'manual',
        'OPEN',
        count(*)::int,
        sum(l."quantity"),
        sum(l."quantity" * l."entryPrice") / nullif(sum(l."quantity"), 0),
        0, 0, 0,
        min(l."openedAt")
      FROM "position_lots" l
      WHERE l."status" = 'OPEN'
      GROUP BY l."market", l."symbol"
    `);

    await queryRunner.query(`
      UPDATE "position_lots" l
      SET "basketId" = b."id"
      FROM "baskets" b
      WHERE l."status" = 'OPEN'
        AND l."basketId" IS NULL
        AND l."market" = b."market"
        AND l."symbol" = b."symbol"
        AND b."code" LIKE 'BK-LEGACY-%'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lots_basket"`);
    await queryRunner.query(`ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "basketId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baskets_market_symbol_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baskets_code"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "baskets"`);
  }
}
