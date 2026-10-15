import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 仓位表新增交易所侧灾难保险丝字段（exchange-protection-orders-plan Phase 1）。
 *
 * 背景：为每个 OPEN Lot 在交易所挂一条 STOP_MARKET 反向平仓单（触发价=灾难线），
 * 进程猝死时交易所侧仍兜底平仓。本地需要记住「当前有效保护单」及其触发价。
 *
 * - `protectionOrderId`：1:1 指向仍存活保险丝订单；NULL=未注册/已撤。
 * - `protectedStopPrice`：灾难价；0=未注册。
 *
 * 严格 `PROTECTION_MODE=off`（默认）时这两列恒为初始值，对既有行/当前 dry_run 零影响，
 * 回测也不写这两列。生产环境 synchronize=false，需本迁移补列。
 */
export class ExchangeProtectiveStop1700000026000 implements MigrationInterface {
  name = 'ExchangeProtectiveStop1700000026000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "position_lots" ADD COLUMN IF NOT EXISTS "protectionOrderId" varchar(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "position_lots" ADD COLUMN IF NOT EXISTS "protectedStopPrice" numeric(28,10) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "protectedStopPrice"`,
    );
    await queryRunner.query(
      `ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "protectionOrderId"`,
    );
  }
}
