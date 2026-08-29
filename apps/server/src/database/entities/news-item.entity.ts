import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('news_items')
@Index(['url'], { unique: true })
export class NewsItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'text' })
  url: string;

  @Column({ length: 64, default: '' })
  source: string;

  @Index()
  @Column({ type: 'timestamptz' })
  publishedAt: Date;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  tags: string[];

  /** 被决策引用的次数 */
  @Column({ default: 0 })
  citedCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
