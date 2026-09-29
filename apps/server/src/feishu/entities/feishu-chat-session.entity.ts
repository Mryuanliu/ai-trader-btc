import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 会话消息（持久化的简化历史，只存 user/assistant 文本；工具消息不落库） */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/**
 * 飞书群 ↔ 多轮会话绑定。
 *
 * 每个 (tenantKey, chatId) 一份会话：保留最近 N 条纯文本消息作为 LLM 历史，
 * `/new` 清空。工具调用链不回存（体积大且跨轮无意义），只回存用户问题与最终回答。
 */
@Entity('feishu_chat_sessions')
@Index(['tenantKey', 'chatId'], { unique: true })
export class FeishuChatSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  tenantKey: string;

  /** 群 chat_id（oc_ 开头） */
  @Column({ type: 'varchar', length: 128 })
  chatId: string;

  /** 最近一次提问的用户 open_id（预留：私聊/定向回复场景） */
  @Column({ type: 'varchar', length: 128, default: '' })
  openId: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  messages: StoredChatMessage[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
