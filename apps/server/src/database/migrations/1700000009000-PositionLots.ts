import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 仓位单（Position Lot）：订单级仓位管理（方案 docs/order-lot-position-plan.md）。
 *
 * 背景：原模型是净持仓 + FIFO 启发式回合配对，平仓可部分卖出（碎单蚕食持仓）、
 * 止盈止损挂净持仓均价，无法回答「这笔订单赚了多少、何时了结」。
 *
 * 新模型：1 开仓订单 ↔ 1 Lot ↔ 1 平仓订单；每单独立止盈止损（快照落库）；
 * 全量平仓才算完结；realizedPnl 完结时落定（净额，扣双边手续费）。
 *
 * 存量持仓不迁移（用户决定手动在币安测试网平掉），上线后新开仓从零建 Lot。
 */
export class PositionLots1700000009000 implements MigrationInterface {
  name = 'PositionLots1700000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "position_lots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "market" varchar(16) NOT NULL,
        "symbol" varchar(20) NOT NULL,
        "direction" varchar(8) NOT NULL,
        "openOrderId" uuid NOT NULL,
        "closeOrderId" uuid,
        "quantity" numeric(28,10) NOT NULL,
        "closedQuantity" numeric(28,10) NOT NULL DEFAULT 0,
        "entryPrice" numeric(28,10) NOT NULL,
        "entryFeeUsdt" numeric(28,10) NOT NULL DEFAULT 0,
        "exitPrice" numeric(28,10),
        "exitFeeUsdt" numeric(28,10),
        "status" varchar(16) NOT NULL,
        "stopLossPct" numeric(10,6) NOT NULL,
        "takeProfitPct" numeric(10,6) NOT NULL,
        "exitReason" varchar(24),
        "realizedPnl" numeric(28,10),
        "returnPct" numeric(14,8),
        "openedAt" timestamptz NOT NULL,
        "closedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_position_lots" PRIMARY KEY ("id")
      )
    `);
    // 决策循环逐 Lot 扫描 TP/SL、持仓页列表都按 market+symbol+status 查
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lots_market_symbol_status" ON "position_lots" ("market","symbol","status")`,
    );
    // 开仓订单 → Lot 反查（订单页分组、成交回调防重复建 Lot）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_lots_open_order" ON "position_lots" ("openOrderId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lots_open_order"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lots_market_symbol_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "position_lots"`);
  }
}
