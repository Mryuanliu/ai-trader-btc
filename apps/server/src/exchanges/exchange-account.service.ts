import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ENVIRONMENT_LABELS,
  EXCHANGE_CODES,
  ExchangeCode,
  Environment,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { ExchangeAccountEntity } from '../database/entities';
import { decryptSecret, encryptSecret, maskSecret } from '../common/crypto.util';
import { describeProxy } from '../common/proxy';
import { ExchangeCredentials } from './adapter.interface';

export interface ExchangeAccountView {
  id: string;
  exchange: ExchangeCode;
  label: string;
  environment: Environment;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  message: string;
  apiKeyMasked: string;
  hasPassphrase: boolean;
}

export interface UpsertExchangeAccountInput {
  exchange: ExchangeCode;
  label?: string;
  environment?: Environment;
  enabled?: boolean;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
}

@Injectable()
export class ExchangeAccountService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeAccountService.name);

  constructor(
    @InjectRepository(ExchangeAccountEntity)
    private readonly repo: Repository<ExchangeAccountEntity>,
    private readonly config: ConfigService,
  ) {}

  private get masterKey(): string {
    return this.config.get<string>('APP_MASTER_KEY', 'change-me-32-bytes-master-key-please');
  }

  /** 启动时把 .env 里的密钥同步到数据库（仅在该交易所尚无记录时写入） */
  async onModuleInit() {
    this.logger.log(`网络出口：${describeProxy()}`);
    await this.seedFromEnv();
  }

  /** 解析账户环境：优先 BINANCE_ENV，未设置时回退到旧的 BINANCE_TESTNET 布尔推断 */
  private resolveEnvironment(prefix: string): Environment {
    const explicit = this.config.get<string>(`${prefix}_ENV`, '');
    if (explicit === 'demo' || explicit === 'testnet' || explicit === 'live') {
      return explicit;
    }
    return this.config.get<string>(`${prefix}_TESTNET`, 'true') !== 'false' ? 'testnet' : 'live';
  }

  async seedFromEnv() {
    for (const code of EXCHANGE_CODES) {
      const prefix = code.toUpperCase();
      const apiKey = this.config.get<string>(`${prefix}_API_KEY`, '') || '';
      const apiSecret = this.config.get<string>(`${prefix}_API_SECRET`, '') || '';
      const passphrase = this.config.get<string>(`${prefix}_PASSPHRASE`, '') || '';
      const enabled = this.config.get<string>(`${prefix}_ENABLED`, 'false') === 'true';
      const environment = this.resolveEnvironment(prefix);

      if (!apiKey && !apiSecret) continue;

      let entity = await this.repo.findOne({ where: { exchange: code } });
      if (!entity) {
        entity = this.repo.create({ exchange: code });
      }
      entity.label = code === 'binance' ? '币安' : '欧意';
      entity.environment = environment;
      entity.enabled = enabled;
      entity.apiKeyEnc = encryptSecret(apiKey, this.masterKey);
      entity.apiSecretEnc = encryptSecret(apiSecret, this.masterKey);
      entity.passphraseEnc = encryptSecret(passphrase, this.masterKey);
      await this.repo.save(entity);
      this.logger.log(
        `已从环境变量加载 ${code} 账户配置（环境=${ENVIRONMENT_LABELS[environment]}，Key=${maskSecret(apiKey)}）`,
      );
    }

    // 保证每家交易所都有一条记录，便于后台统一编辑
    for (const code of EXCHANGE_CODES) {
      const exists = await this.repo.findOne({ where: { exchange: code } });
      if (!exists) {
        const environment = this.resolveEnvironment(code.toUpperCase());
        await this.repo.save(
          this.repo.create({
            exchange: code,
            label: code === 'binance' ? '币安' : '欧意',
            environment,
            enabled: false,
            lastMessage: '未配置密钥，仅可用于公共行情',
          }),
        );
      }
    }
  }

  async list(): Promise<ExchangeAccountView[]> {
    const rows = await this.repo.find({ order: { exchange: 'ASC' } });
    return rows.map((row) => this.toView(row));
  }

  async findOne(code: ExchangeCode): Promise<ExchangeAccountEntity | null> {
    return this.repo.findOne({ where: { exchange: code } });
  }

  toView(row: ExchangeAccountEntity): ExchangeAccountView {
    const apiKey = decryptSecret(row.apiKeyEnc, this.masterKey);
    return {
      id: row.id,
      exchange: row.exchange,
      label: row.label,
      environment: row.environment,
      enabled: row.enabled,
      configured: Boolean(apiKey),
      reachable: row.reachable,
      message: row.lastMessage,
      apiKeyMasked: maskSecret(apiKey),
      hasPassphrase: Boolean(decryptSecret(row.passphraseEnc, this.masterKey)),
    };
  }

  async getCredentials(code: ExchangeCode): Promise<ExchangeCredentials | null> {
    const row = await this.repo.findOne({ where: { exchange: code } });
    if (!row) return null;
    const apiKey = decryptSecret(row.apiKeyEnc, this.masterKey);
    const apiSecret = decryptSecret(row.apiSecretEnc, this.masterKey);
    if (!apiKey || !apiSecret) return null;
    return {
      apiKey,
      apiSecret,
      passphrase: decryptSecret(row.passphraseEnc, this.masterKey),
      environment: row.environment,
    };
  }

  async upsert(input: UpsertExchangeAccountInput): Promise<ExchangeAccountView> {
    let row = await this.repo.findOne({ where: { exchange: input.exchange } });
    if (!row) {
      row = this.repo.create({
        exchange: input.exchange,
        label: input.label ?? input.exchange,
      });
    }
    if (input.label !== undefined) row.label = input.label;
    if (input.environment !== undefined) row.environment = input.environment;
    if (input.enabled !== undefined) row.enabled = input.enabled;
    // 空字符串表示不修改密钥，避免前端回传掩码覆盖真实密钥
    if (input.apiKey) row.apiKeyEnc = encryptSecret(input.apiKey, this.masterKey);
    if (input.apiSecret) row.apiSecretEnc = encryptSecret(input.apiSecret, this.masterKey);
    if (input.passphrase) row.passphraseEnc = encryptSecret(input.passphrase, this.masterKey);

    const saved = await this.repo.save(row);
    return this.toView(saved);
  }

  async updateProbe(code: ExchangeCode, reachable: boolean, message: string) {
    await this.repo.update({ exchange: code }, { reachable, lastMessage: message });
  }
}
