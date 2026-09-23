import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * orders 表加 lotId：让平仓单能精确追溯其目标 Lot。
 *
 * 背景（2026-09-02 审计 P1）：平仓单下单时未记录目标 Lot，导致 demo 异步成交
 * （POST /fapi/v1/order 响应 executedQty=0）走 syncPendingFills 兜底补记时，
 * 只能用 FIFO 猜「最老的同方向 Lot」结算——多仓并存时可能结错仓。
 *
 * 加列后：placeOrder 平仓时把 lotId 写入订单，syncPendingFills 用它精确结算，
 * 不再需要 FIFO 猜测，出场原因（STOP_LOSS/TAKE_PROFIT/MANUAL）也能精确归因。
 *
 * 存量历史平仓单 lotId 为 NULL（无法追溯，保留 FIFO 兜底逻辑作兼容）。
 */
export class OrderLotId1700000010000 implements MigrationInterface {
  name = 'OrderLotId1700000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "lotId" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_lotId" ON "orders" ("lotId")
        WHERE "lotId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_lotId"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "lotId"`);
  }
}
