import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * futures_agent_configs 瘦身：删除决策引擎/风控遗留列。
 *
 * 背景（2026-09-23 策略托管改造）：平台不再有决策引擎与风控，
 * 这些列不再有任何读写路径：
 * - strategyName / strategyParams / decisionLane / minConfidence / exitRules
 *   → 策略选择与出场规则由策略自己管
 * - maxLeverage / liquidationBufferPct → 平台不做杠杆与强平距离风控
 * - lastDecisionId / timeframe / decisionIntervalSec / name → 决策调度的产物
 *
 * down 不恢复：这些列承载的是已删除引擎的配置，恢复没有意义。
 */
export class FuturesConfigSlim1700000012000 implements MigrationInterface {
  name = 'FuturesConfigSlim1700000012000';

  private static readonly DROPPED_COLUMNS = [
    'name',
    'timeframe',
    'decisionIntervalSec',
    'minConfidence',
    'maxLeverage',
    'liquidationBufferPct',
    'decisionLane',
    'strategyName',
    'strategyParams',
    'exitRules',
    'lastDecisionId',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of FuturesConfigSlim1700000012000.DROPPED_COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "futures_agent_configs" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }

  public async down(): Promise<void> {
    // 有意留空：被删列属于已移除的决策引擎，无需恢复
  }
}
