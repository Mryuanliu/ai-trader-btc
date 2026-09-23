import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除决策链路遗留列。
 *
 * - `orders.decisionId`：旧决策引擎的决策 ID。策略托管后不再有决策记录，
 *   下单时恒写 null，留着只会让「订单←决策」的关联看起来存在。
 * - `position_lots.stopLossPct` / `takeProfitPct`：逐层止盈止损。
 *   出场改由策略负责（马丁网格用篮子追踪止盈），平台既不扫描也不落这两个参数，
 *   它们会恒为 0 —— 保留反而误导（前端一度按它渲染出「止损价 = 开仓价」）。
 *
 * down 有意留空：恢复没有意义（对应的决策引擎与逐层 TP/SL 能力都已删除）。
 */
export class DropDecisionAndLotTpSl1700000014000 implements MigrationInterface {
  name = 'DropDecisionAndLotTpSl1700000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "decisionId"`);
    await queryRunner.query(`ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "stopLossPct"`);
    await queryRunner.query(`ALTER TABLE "position_lots" DROP COLUMN IF EXISTS "takeProfitPct"`);
  }

  public async down(): Promise<void> {
    // 有意留空：见类注释
  }
}
