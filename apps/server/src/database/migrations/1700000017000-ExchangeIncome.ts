import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 交易所资金流水表：让盈亏口径与交易所真实到账一致。
 *
 * 背景：原来盈亏只用 `trade_fills` 算（价格差 − 双边手续费），
 * 但**资金费（持仓费用）不产生成交**，每 8 小时独立结算，
 * 所以按成交算出来的盈亏和账户实际到账永远差一截（今日盈亏与篮子盈亏也对不上）。
 *
 * 本表存 `REALIZED_PNL / COMMISSION / FUNDING_FEE` 等全部流水，
 * `tranId` 唯一索引保证可重复拉取而不重复记账。
 */
export class ExchangeIncome1700000017000 implements MigrationInterface {
  name = 'ExchangeIncome1700000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "exchange_incomes" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tranId" character varying(48) NOT NULL,
        "incomeType" character varying(32) NOT NULL,
        "symbol" character varying(20) NOT NULL DEFAULT '',
        "asset" character varying(12) NOT NULL DEFAULT 'USDT',
        "amount" numeric(28,10) NOT NULL,
        "time" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_incomes_tran" ON "exchange_incomes" ("tranId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incomes_time" ON "exchange_incomes" ("time")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incomes_type_symbol" ON "exchange_incomes" ("incomeType", "symbol")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incomes_type_symbol"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incomes_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incomes_tran"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "exchange_incomes"`);
  }
}
