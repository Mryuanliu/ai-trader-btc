import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * 飞书消息回执（幂等去重）。
 *
 * 飞书对事件推送有重试机制：长连接抖动时同一条 im.message.receive_v1
 * 可能被投递多次。messageId 作主键，插入冲突即代表「已处理过」，直接丢弃，
 * 保证一条群消息只驱动一次 LLM 循环（否则一次提问会被回答多遍）。
 */
@Entity('feishu_message_receipts')
export class FeishuMessageReceiptEntity {
  /** 飞书 message_id（om_ 开头），天然唯一 */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  messageId: string;

  /** 租户标识（event.tenant_key / app_id），多租户预留 */
  @Column({ type: 'varchar', length: 128, default: '' })
  tenantKey: string;

  @CreateDateColumn()
  createdAt: Date;
}
