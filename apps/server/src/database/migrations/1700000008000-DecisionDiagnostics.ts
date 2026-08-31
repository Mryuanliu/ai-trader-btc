import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 决策诊断：为「为什么没开单」建立可观测能力（策略增强方案 A 期）。
 *
 * 背景：历史 386 条决策中 BUY=0、HOLD=361 且 confidence 恒为 0，
 * 无法区分「差一点就开仓」还是「差得远」，也不知道是哪个信号拖后腿。
 *
 * 新增列（三列均可空，对存量数据零影响）：
 * - proximity float8：接近度 0~1，|score| / entryThreshold，观望时仍有效
 * - blockingReason varchar(32)：阻塞原因码（可枚举，便于聚合 Top 统计）
 * - diagnostics jsonb：信号贡献度、达标差距等明细（不进热路径）
 *
 * 同时修正 agent_decisions.lane 的默认值：原默认 'llm'（AI 直出买卖链路）已移除，
 * 改为 'strategy'。存量 'llm' 值保留（读取时归一为 strategy，保留历史真实性）。
 */
export class DecisionDiagnostics1700000008000 implements MigrationInterface {
  name = 'DecisionDiagnostics1700000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "proximity" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "blockingReason" varchar(32)`,
    );
    await queryRunner.query(`ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "diagnostics" jsonb`);

    // 阻塞原因码需要按时间窗聚合 Top，建索引支撑诊断面板查询
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_decisions_blockingReason" ON "agent_decisions" ("blockingReason")`,
    );

    // lane 默认值：'llm' 链路已移除，改为 'strategy'
    await queryRunner.query(
      `ALTER TABLE "agent_decisions" ALTER COLUMN "lane" SET DEFAULT 'strategy'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_decisions_blockingReason"`);
    await queryRunner.query(`ALTER TABLE "agent_decisions" DROP COLUMN IF EXISTS "diagnostics"`);
    await queryRunner.query(`ALTER TABLE "agent_decisions" DROP COLUMN IF EXISTS "blockingReason"`);
    await queryRunner.query(`ALTER TABLE "agent_decisions" DROP COLUMN IF EXISTS "proximity"`);
    await queryRunner.query(`ALTER TABLE "agent_decisions" ALTER COLUMN "lane" SET DEFAULT 'llm'`);
  }
}
