import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ENVIRONMENT_LABELS,
  EXCHANGE_CODES,
  ExchangeCode,
  Environment,
} from '@ai-trader/shared';
import { BinanceAdapter } from './binance.adapter';
import { OkxAdapter } from './okx.adapter';
import { ExchangeAccountService } from './exchange-account.service';
import { ExchangeAdapter, ExchangeError } from './adapter.interface';

@Injectable()
export class ExchangeRegistry {
  private readonly logger = new Logger(ExchangeRegistry.name);
  private readonly cache = new Map<string, ExchangeAdapter>();

  constructor(
    private readonly accounts: ExchangeAccountService,
    private readonly config: ConfigService,
  ) {}

  private get defaultEnvironment(): Environment {
    const mode = this.config.get<string>('APP_RUN_MODE', 'dry_run');
    // 非实盘一律落到模拟环境；显式配置了 BINANCE_ENV 时以配置为准
    if (mode !== 'live') {
      const configured = this.config.get<string>('BINANCE_ENV', 'demo');
      return configured === 'testnet' || configured === 'demo' || configured === 'live'
        ? configured
        : 'demo';
    }
    return 'live';
  }

  /** 清除适配器缓存（密钥更新后调用） */
  invalidate(code?: ExchangeCode) {
    if (code) {
      this.cache.delete(code);
      return;
    }
    this.cache.clear();
  }

  /** 获取指定交易所适配器（无密钥时返回只能读公共行情的适配器） */
  async get(code: ExchangeCode): Promise<ExchangeAdapter> {
    const cached = this.cache.get(code);
    if (cached) return cached;

    const credentials = await this.accounts.getCredentials(code);
    const environment = credentials?.environment ?? this.defaultEnvironment;

    const adapter: ExchangeAdapter =
      code === 'binance'
        ? new BinanceAdapter(environment, credentials?.apiKey ?? '', credentials?.apiSecret ?? '')
        : new OkxAdapter(
            environment,
            credentials?.apiKey ?? '',
            credentials?.apiSecret ?? '',
            credentials?.passphrase ?? '',
          );

    this.cache.set(code, adapter);
    return adapter;
  }

  /** 取第一个可用于公共行情的适配器 */
  async getPublic(): Promise<ExchangeAdapter> {
    for (const code of EXCHANGE_CODES) {
      const adapter = await this.get(code);
      return adapter;
    }
    return this.get('binance');
  }

  /** 已启用且已配置密钥的交易所，用于真实下单 */
  async getTradable(): Promise<ExchangeAdapter[]> {
    const views = await this.accounts.list();
    const enabled = views.filter((v) => v.enabled && v.configured);
    const result: ExchangeAdapter[] = [];
    for (const view of enabled) {
      result.push(await this.get(view.exchange));
    }
    return result;
  }

  /** 连通性探测：先打交易主机时间接口，有密钥再读余额 */
  async probe(code: ExchangeCode): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    const started = Date.now();
    try {
      const adapter = await this.get(code);
      const envLabel = ENVIRONMENT_LABELS[adapter.environment];
      await adapter.getServerTime();

      let message: string;
      if (adapter.hasCredentials) {
        const balances = await adapter.getBalances();
        const preview = balances
          .slice(0, 4)
          .map((b) => `${b.asset} ${b.total}`)
          .join('，');
        message = `${envLabel}连接正常，已读取 ${balances.length} 个非零币种${preview ? `（${preview}${balances.length > 4 ? '…' : ''}）` : ''}`;
      } else {
        message = `${envLabel}接口连通（未配置密钥，无法读取余额）`;
      }
      await this.accounts.updateProbe(code, true, message);
      return { ok: true, message, latencyMs: Date.now() - started };
    } catch (err) {
      let message =
        err instanceof ExchangeError ? err.message : `连接失败: ${(err as Error).message}`;
      // 超时大概率是网络不通，追加可操作的排查提示
      if (/超时|ETIMEDOUT|ECONNABORTED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        message = `${message}；请检查网络是否可访问该域名，必要时配置 HTTPS_PROXY`;
      }
      this.logger.warn(`[${code}] 连通性探测失败: ${message}`);
      await this.accounts.updateProbe(code, false, message);
      return { ok: false, message, latencyMs: Date.now() - started };
    }
  }
}
