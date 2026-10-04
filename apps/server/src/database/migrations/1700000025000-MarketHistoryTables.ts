import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1-A3 L1 数据栈：event-driven 回测的时点事实表（Point-in-Time）。
 *
 * 7 张新表全部为**幂等创建**（`IF NOT EXISTS`），既能在生产 `synchronize:false` 下
 * 由本迁移建齐，又能在开发 `synchronize:true` 已建表的情况下不冲突（TypeORM 已建则
 * 本迁移仅补索引）。字段与实体严格对齐。
 *
 * 时间轴类主键：`(symbol, market, ts)` 唯一 + `(ts)` 二级索引，支持 event-driven 引擎
 * 按窗口拉取归并（`merge_by_ts(aggTrades, L2Snapshots, markPriceTicks, fundingSettlements)`，
 * 方案 A4 第 33 行）。
 *
 * 冷热分层：本表按 (symbol, market, ts) 复合索引即可支撑近 1 年热数据；冷归档走
 * `data.binance.vision` 月度 zip 由外部脚本回填，不建 DB 分区（避免引入 TimescaleDB 依赖）。
 *
 * L2/liquidation 两张表当前无 Binance REST 历史源，仅建壳；WS 采集器待 P1b 落地。
 */
export class MarketHistoryTables1700000025000 implements MigrationInterface {
  name = 'MarketHistoryTables1700000025000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- 1. market_agg_trades ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_agg_trades" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "aggTradeId" bigint NOT NULL,
        "tradeTime" bigint NOT NULL,
        "price" double precision NOT NULL,
        "qty" double precision NOT NULL,
        "quoteQty" double precision NOT NULL DEFAULT 0,
        "isBuyerMaker" boolean NOT NULL DEFAULT false,
        "firstId" bigint,
        "lastId" bigint,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_agg_trades" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_agg_trades_unique"
        ON "market_agg_trades" ("symbol", "market", "aggTradeId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_agg_trades_ts"
        ON "market_agg_trades" ("symbol", "market", "tradeTime")
    `);

    // ---------- 2. market_funding_rates ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_funding_rates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "fundingTime" bigint NOT NULL,
        "fundingRate" numeric(20,12) NOT NULL,
        "markPrice" double precision,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_funding_rates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_funding_rates_unique"
        ON "market_funding_rates" ("symbol", "fundingTime")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_funding_rates_symbol"
        ON "market_funding_rates" ("symbol", "fundingTime")
    `);

    // ---------- 3. market_mark_prices ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_mark_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "ts" bigint NOT NULL,
        "markPrice" double precision NOT NULL,
        "indexPrice" double precision,
        "lastFundingRate" numeric(20,12),
        "nextFundingTime" bigint,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_mark_prices" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_mark_prices_unique"
        ON "market_mark_prices" ("symbol", "market", "ts")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_mark_prices_ts"
        ON "market_mark_prices" ("symbol", "market", "ts")
    `);

    // ---------- 4. market_open_interest ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_open_interest" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "ts" bigint NOT NULL,
        "openInterest" double precision NOT NULL,
        "openInterestValue" double precision NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_open_interest" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_open_interest_unique"
        ON "market_open_interest" ("symbol", "market", "ts")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_open_interest_ts"
        ON "market_open_interest" ("symbol", "market", "ts")
    `);

    // ---------- 5. market_l2_snapshots ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_l2_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "ts" bigint NOT NULL,
        "bids" jsonb NOT NULL,
        "asks" jsonb NOT NULL,
        "sequence" bigint,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_l2_snapshots" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_l2_snapshots_unique"
        ON "market_l2_snapshots" ("symbol", "market", "ts")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_l2_snapshots_ts"
        ON "market_l2_snapshots" ("symbol", "market", "ts")
    `);

    // ---------- 6. market_liquidations ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_liquidations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "ts" bigint NOT NULL,
        "side" character varying(8) NOT NULL,
        "price" double precision NOT NULL,
        "qty" double precision NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_liquidations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_market_liquidations_ts"
        ON "market_liquidations" ("symbol", "market", "ts")
    `);

    // ---------- 7. market_symbol_meta ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_symbol_meta" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "symbol" character varying(32) NOT NULL,
        "market" character varying(8) NOT NULL DEFAULT 'futures',
        "contractType" character varying(32) NOT NULL DEFAULT 'PERPETUAL',
        "quoteAsset" character varying(16) NOT NULL DEFAULT 'USDT',
        "tickSize" double precision NOT NULL DEFAULT 0.1,
        "stepSize" double precision NOT NULL DEFAULT 0.001,
        "minNotional" double precision NOT NULL DEFAULT 100,
        "pricePrecision" integer NOT NULL DEFAULT 2,
        "quantityPrecision" integer NOT NULL DEFAULT 3,
        "maxLeverage" integer NOT NULL DEFAULT 20,
        "marginTiers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "leverageBrackets" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "fetchedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_symbol_meta" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_symbol_meta_unique"
        ON "market_symbol_meta" ("symbol", "market")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序删除，索引会随表一起 DROP
    await queryRunner.query(`DROP TABLE IF EXISTS "market_symbol_meta"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_liquidations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_l2_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_open_interest"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_mark_prices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_funding_rates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_agg_trades"`);
  }
}
