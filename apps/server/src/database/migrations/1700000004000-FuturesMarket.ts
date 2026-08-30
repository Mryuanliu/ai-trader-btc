import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 阶段 5 · 合约市场维度。
 *
 * 为「现货 / 合约双市场」做准备：
 * - `market_candles` 新增 `market` 列（'spot' | 'futures'），唯一索引纳入该列，
 *   使现货与合约同标的 K 线可共存（二者时间轴一致但存在基差，不可互相覆盖）。
 * - 新建 `funding_rates` 资金费率表，供合约回测按持仓区间累计费率。
 *
 * 存量数据处理：既有 K 线全部标记为 'spot'，现货行情与回测结果零变化。
 *
 * 幂等性：本地环境 DB_SYNCHRONIZE=true 时表结构可能已由 synchronize 建好，
 * 故全部语句使用 IF NOT EXISTS；旧唯一索引因 TypeORM 自动生成哈希名
 * （如 IDX_93e41e4e2c31265fe18d711b5b）而无法硬编码，改为按列集合动态识别删除。
 */
export class FuturesMarket1700000004000 implements MigrationInterface {
  name = 'FuturesMarket1700000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 新增 market 列，存量行统一落到 'spot'
    await queryRunner.query(
      `ALTER TABLE "market_candles" ADD COLUMN IF NOT EXISTS "market" varchar(8) NOT NULL DEFAULT 'spot'`,
    );
    await queryRunner.query(
      `UPDATE "market_candles" SET "market" = 'spot' WHERE "market" IS NULL OR "market" = ''`,
    );

    // 2. 删除旧的 (symbol, interval, openTime) 唯一索引。
    //    它是 synchronize 自动生成的哈希名，无法硬编码，按列集合精确匹配后删除。
    //    不删则同一根 K 线无法同时存现货与合约两条记录。
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT i.relname AS idx_name
          FROM pg_class t
          JOIN pg_index x ON t.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          WHERE t.relname = 'market_candles'
            AND x.indisunique
            AND NOT x.indisprimary
            AND (
              -- attname 是 name 类型，需显式转 text 才能与 text[] 字面量比较
              SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(x.indkey::int2[]) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
            ) = ARRAY['interval','openTime','symbol']
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I', r.idx_name);
        END LOOP;
      END $$;
    `);

    // 3. 建立含 market 维度的新唯一索引与市场筛选索引（名称与实体声明一致）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_candles_unique"
         ON "market_candles" ("symbol", "market", "interval", "openTime")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_market_candles_market" ON "market_candles" ("market")`,
    );

    // 4. 资金费率表：每 8h 结算一次，回测需按持仓区间累计
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "funding_rates" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "symbol" varchar(32) NOT NULL,
        "fundingTime" bigint NOT NULL,
        "rate" double precision NOT NULL,
        "markPrice" double precision
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_funding_rates_symbol_time"
        ON "funding_rates" ("symbol", "fundingTime");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 合约 K 线在回滚后无处安放（唯一索引回到三列会冲突），直接丢弃；
    // 该数据可从交易所重新拉取，不影响现货。
    await queryRunner.query(
      `DELETE FROM "market_candles" WHERE "market" <> 'spot'`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_market_candles_market"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_market_candles_unique"`);
    await queryRunner.query(
      `ALTER TABLE "market_candles" DROP COLUMN IF EXISTS "market"`,
    );

    // 还原现货三列唯一索引
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_candles_unique"
         ON "market_candles" ("symbol", "interval", "openTime")`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "funding_rates"`);
  }
}
