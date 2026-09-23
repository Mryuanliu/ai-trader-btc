import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 加宽 `orders.type` 以容纳条件单类型。
 *
 * 背景：`OrderType` 新增了 `STOP_MARKET`(11 字符) 与 `TAKE_PROFIT_MARKET`(18 字符)
 * 用于策略的网格挂单，但列宽仍是 `varchar(8)`（只够 MARKET/LIMIT）。
 * 结果是每次挂网格单都被数据库拒绝：
 * `value too long for type character varying(8)`，
 * 策略不停报"挂单失败"却看不出是列宽问题。
 *
 * down 收窄回 8 会截断/失败，故留空。
 */
export class WidenOrderType1700000015000 implements MigrationInterface {
  name = 'WidenOrderType1700000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "type" TYPE varchar(24)`);
  }

  public async down(): Promise<void> {
    // 有意留空：列宽收窄会破坏已写入的条件单类型
  }
}
