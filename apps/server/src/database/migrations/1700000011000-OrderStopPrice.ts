import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * orders 表加 stopPrice：承载**条件触发单**的触发价。
 *
 * 背景（2026-09-23 策略托管改造）：马丁网格的待成交层是「挂单」而非市价单——
 * 策略挂出 STOP_MARKET 后订单停在 NEW，价格触及由交易所触发成交，
 * 之后由 syncPendingFills 对账补记成交明细与 Lot。
 *
 * 没有这一列时，挂单只能记委托价（price=0），
 * 策略无法判断「这一层挂在哪个价位」，也无法在网格重排时正确识别自己的单。
 *
 * 存量历史订单 stopPrice 为 0（那时没有挂单概念）。
 */
export class OrderStopPrice1700000011000 implements MigrationInterface {
  name = 'OrderStopPrice1700000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "stopPrice" float8 NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "stopPrice"`);
  }
}
