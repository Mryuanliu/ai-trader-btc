import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除死表（策略托管改造的收尾）。
 *
 * 这些表在改造后已无任何实体注册与读写路径，留着只会积累脏数据
 * （改造时两者合计已超 10 万行）并让新同学误以为是活表：
 *
 * - `risk_events`：风控已整体移除（平台不做风控）
 * - `agent_decisions`：决策引擎已移除（策略直接运行，不再产出决策记录）
 * - `agent_configs`：现货链路已移除（当前只有 futures_agent_configs）
 * - `balance_snapshots`：原「权益 − 当日快照」的今日盈亏口径已被
 *   「成交推导」取代，实体只剩 module 里的注册、无任何读写
 * - `funding_rates`：仅供已删除的合约回测使用，适配器方法也无调用方
 *
 * 用迁移而不是手工 DROP：`InitSchema` 会在新库重建这些表，
 * 走迁移才能保证「新库 = 现状库」，不会再长回来。
 *
 * down 有意留空：这些表属于已移除的模块，恢复没有意义。
 */
export class DropDeadTables1700000013000 implements MigrationInterface {
  name = 'DropDeadTables1700000013000';

  private static readonly DEAD_TABLES = [
    'risk_events',
    'agent_decisions',
    'agent_configs',
    'balance_snapshots',
    'funding_rates',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of DropDeadTables1700000013000.DEAD_TABLES) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
  }

  public async down(): Promise<void> {
    // 有意留空：见类注释
  }
}
