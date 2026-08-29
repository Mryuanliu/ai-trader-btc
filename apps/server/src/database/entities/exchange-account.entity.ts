import { ExchangeCode, Environment } from '@ai-trader/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 交易所账户：密钥以密文落库，接口只返回掩码 */
@Entity('exchange_accounts')
@Index(['exchange'], { unique: true })
export class ExchangeAccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  exchange: ExchangeCode;

  @Column({ length: 64, default: '' })
  label: string;

  @Column({ type: 'varchar', length: 16, default: 'testnet' })
  environment: Environment;

  @Column({ type: 'text', default: '' })
  apiKeyEnc: string;

  @Column({ type: 'text', default: '' })
  apiSecretEnc: string;

  /** OKX 需要 passphrase */
  @Column({ type: 'text', default: '' })
  passphraseEnc: string;

  @Column({ default: false })
  enabled: boolean;

  /** 最近一次连通性测试结果 */
  @Column({ default: false })
  reachable: boolean;

  @Column({ type: 'text', default: '' })
  lastMessage: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
