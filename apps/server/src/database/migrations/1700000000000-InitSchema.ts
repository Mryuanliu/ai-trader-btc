import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始 schema。开发环境下 DB_SYNCHRONIZE=true 会自动建表；
 * 生产环境请关闭 synchronize 并统一执行 `pnpm migration:run`。
 */
export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "username" varchar(64) NOT NULL,
        "passwordHash" varchar(255) NOT NULL,
        "role" varchar(32) DEFAULT 'admin',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_username" ON "users" ("username");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "exchange_accounts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "exchange" varchar(16) NOT NULL,
        "label" varchar(64) DEFAULT '',
        "environment" varchar(16) DEFAULT 'testnet',
        "apiKeyEnc" text DEFAULT '',
        "apiSecretEnc" text DEFAULT '',
        "passphraseEnc" text DEFAULT '',
        "enabled" boolean DEFAULT false,
        "reachable" boolean DEFAULT false,
        "lastMessage" text DEFAULT '',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_exchange_accounts_exchange" ON "exchange_accounts" ("exchange");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "market_candles" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "symbol" varchar(32) NOT NULL,
        "interval" varchar(8) NOT NULL,
        "openTime" bigint NOT NULL,
        "open" float8 DEFAULT 0,
        "high" float8 DEFAULT 0,
        "low" float8 DEFAULT 0,
        "close" float8 DEFAULT 0,
        "volume" float8 DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_market_candles_unique"
        ON "market_candles" ("symbol", "interval", "openTime");
      CREATE INDEX IF NOT EXISTS "IDX_market_candles_open_time" ON "market_candles" ("openTime");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "news_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" text NOT NULL,
        "summary" text DEFAULT '',
        "url" text NOT NULL,
        "source" varchar(64) DEFAULT '',
        "publishedAt" timestamptz NOT NULL,
        "tags" jsonb DEFAULT '[]'::jsonb,
        "citedCount" int DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_news_items_url" ON "news_items" ("url");
      CREATE INDEX IF NOT EXISTS "IDX_news_items_published_at" ON "news_items" ("publishedAt");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_configs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(64) DEFAULT 'BTC 主力 Agent',
        "enabled" boolean DEFAULT false,
        "symbol" varchar(32) DEFAULT 'BTCUSDT',
        "timeframe" varchar(8) DEFAULT '5m',
        "decisionIntervalSec" int DEFAULT 300,
        "mode" varchar(16) DEFAULT 'dry_run',
        "enabledExchanges" jsonb DEFAULT '[]'::jsonb,
        "positionPct" float8 DEFAULT 0.1,
        "minConfidence" float8 DEFAULT 0.6,
        "model" varchar(64) DEFAULT 'deepseek-chat',
        "temperature" float8 DEFAULT 0.2,
        "maxTokens" int DEFAULT 800,
        "systemPrompt" text DEFAULT '',
        "maxOrderAmount" float8 DEFAULT 2000,
        "maxDailyOrders" int DEFAULT 20,
        "maxDrawdownPct" float8 DEFAULT 10,
        "minOrderIntervalSec" int DEFAULT 60,
        "dailyLossLimit" float8 DEFAULT 500,
        "lastRunAt" timestamptz,
        "lastDecisionId" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "orders" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "exchange" varchar(16) NOT NULL,
        "environment" varchar(16) DEFAULT 'testnet',
        "mode" varchar(16) DEFAULT 'dry_run',
        "symbol" varchar(32) NOT NULL,
        "side" varchar(8) NOT NULL,
        "type" varchar(8) NOT NULL,
        "price" float8 DEFAULT 0,
        "quantity" float8 DEFAULT 0,
        "quoteAmount" float8 DEFAULT 0,
        "status" varchar(20) DEFAULT 'NEW',
        "filledQuantity" float8 DEFAULT 0,
        "filledPrice" float8 DEFAULT 0,
        "exchangeOrderId" varchar(64),
        "clientOrderId" varchar(64),
        "source" varchar(16) DEFAULT 'manual',
        "decisionId" varchar(64),
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_orders_symbol_created" ON "orders" ("symbol", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_orders_status" ON "orders" ("status");
      CREATE INDEX IF NOT EXISTS "IDX_orders_created_at" ON "orders" ("createdAt");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trade_fills" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "orderId" varchar(64) NOT NULL,
        "symbol" varchar(32) DEFAULT '',
        "price" float8 DEFAULT 0,
        "quantity" float8 DEFAULT 0,
        "fee" float8 DEFAULT 0,
        "feeAsset" varchar(16) DEFAULT 'USDT',
        "filledAt" timestamptz DEFAULT now(),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_trade_fills_order" ON "trade_fills" ("orderId");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "balance_snapshots" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "exchange" varchar(16) NOT NULL,
        "environment" varchar(16) DEFAULT 'testnet',
        "asset" varchar(16) NOT NULL,
        "free" float8 DEFAULT 0,
        "locked" float8 DEFAULT 0,
        "total" float8 DEFAULT 0,
        "usdtValue" float8 DEFAULT 0,
        "source" varchar(16) DEFAULT 'virtual',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_balance_snapshots_lookup"
        ON "balance_snapshots" ("exchange", "asset", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_balance_snapshots_source"
        ON "balance_snapshots" ("source", "createdAt");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_decisions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "agentId" varchar(64) NOT NULL,
        "symbol" varchar(32) NOT NULL,
        "action" varchar(8) NOT NULL,
        "confidence" float8 DEFAULT 0,
        "reason" text DEFAULT '',
        "riskNotes" text,
        "inputSnapshot" jsonb NOT NULL,
        "prompt" text DEFAULT '',
        "llmRaw" text,
        "llmReasoning" text,
        "llmModel" varchar(64),
        "llmUsage" jsonb,
        "degraded" boolean DEFAULT false,
        "degradeReason" text,
        "riskPassed" boolean DEFAULT true,
        "riskRejectedBy" varchar(64),
        "riskNote" text,
        "orderId" varchar(64),
        "latencyMs" int DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_agent_id" ON "agent_decisions" ("agentId");
      CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_symbol_created" ON "agent_decisions" ("symbol", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_created_at" ON "agent_decisions" ("createdAt");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "risk_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" varchar(32) DEFAULT 'limit',
        "level" varchar(16) DEFAULT 'warn',
        "message" text NOT NULL,
        "symbol" varchar(32) DEFAULT '',
        "decisionId" varchar(64),
        "meta" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_risk_events_level" ON "risk_events" ("level");
      CREATE INDEX IF NOT EXISTS "IDX_risk_events_created_at" ON "risk_events" ("createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "risk_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_decisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "balance_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trade_fills"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_configs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "news_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "market_candles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "exchange_accounts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
