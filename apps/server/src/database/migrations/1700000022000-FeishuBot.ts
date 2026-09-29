import { MigrationInterface, QueryRunner } from 'typeorm';

/** 飞书对话机器人：消息幂等回执表 + 群会话绑定表 */
export class FeishuBot1700000022000 implements MigrationInterface {
  name = 'FeishuBot1700000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "feishu_message_receipts" ("messageId" character varying(128) NOT NULL, "tenantKey" character varying(128) NOT NULL DEFAULT '', "createdAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_feishu_receipts_messageId" PRIMARY KEY ("messageId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "feishu_chat_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantKey" character varying(128) NOT NULL, "chatId" character varying(128) NOT NULL, "openId" character varying(128) NOT NULL DEFAULT '', "messages" jsonb NOT NULL DEFAULT '[]'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_feishu_sessions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_feishu_sessions_tenant_chat" ON "feishu_chat_sessions" ("tenantKey", "chatId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_feishu_sessions_tenant_chat"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feishu_chat_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feishu_message_receipts"`);
  }
}
