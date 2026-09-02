import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ENVIRONMENT_LABELS,
  ExchangeCode,
  Environment,
} from '@ai-trader/shared';
import { BinanceFuturesAdapter } from './binance-futures.adapter';
import { ExchangeAccountService } from './exchange-account.service';
import { ExchangeAdapter, ExchangeError } from './adapter.interface';

/**
 * 已实现适配器的交易所集合。
 *
 * 仅合约模式下只有 `binance-futures`。加交易所码到 EXCHANGE_CODES 后，
 * 若尚未实现适配器就放进遍历，会在 get() 里抛错并连带打断行情与交易链路。
 * 此处作为能力白名单供 isSupported() 使用。
 */
const IMPLEMENTED_EXCHANGES: readonly ExchangeCode[] = ['binance-futures'];

@Injectable()
export class ExchangeRegistry {
  private readonly logger = new Logger(ExchangeRegistry.name);
  private readonly cache = new Map<string, ExchangeAdapter>();

  constructor(
    private readonly accounts: ExchangeAccountService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 账户未落库时的兜底环境：非实盘一律落到模拟环境。
   * 合约读 BINANCE_FUTURES_ENV，未显式配置时回退现货的 BINANCE_ENV。
   */
  private defaultEnvironmentOf(code: ExchangeCode): Environment {
    const mode = this.config.get<string>('APP_RUN_MODE', 'dry_run');
    if (mode === 'live') return 'live';

    const fallback = this.config.get<string>('BINANCE_ENV', 'demo');
    const raw =
      code === 'binance-futures'
        ? this.config.get<string>('BINANCE_FUTURES_ENV', '') || fallback
        : fallback;
    return raw === 'testnet' || raw === 'demo' || raw === 'live' ? raw : 'demo';
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
    const environment = credentials?.environment ?? this.defaultEnvironmentOf(code);
    const apiKey = credentials?.apiKey ?? '';
    const apiSecret = credentials?.apiSecret ?? '';

    // 必须显式 switch：若用 `code === 'binance-futures' ? A : B` 的 else 兜底，
    // 未覆盖的交易所码会静默落到别的适配器（拿 A 的密钥打 B 的接口），不报错但行为完全错误
    let adapter: ExchangeAdapter;
    switch (code) {
      case 'binance-futures':
        adapter = new BinanceFuturesAdapter(environment, apiKey, apiSecret);
        break;
      default: {
        const never: never = code;
        throw new ExchangeError(never, 'UNSUPPORTED', `不支持的交易所: ${String(never)}`);
      }
    }

    this.cache.set(code, adapter);
    return adapter;
  }

  /**
   * 取公共行情适配器。
   *
   * 仅合约模式下合约行情是**唯一**数据源（行情服务用它订阅 K 线/报价流），
   * 不再存在「现货优先、合约有基差」的取舍。
   */
  async getPublic(): Promise<ExchangeAdapter> {
    return this.get('binance-futures');
  }

  /** 已启用、已配置密钥且适配器支持下单的交易所，用于真实下单 */
  async getTradable(): Promise<ExchangeAdapter[]> {
    const views = await this.accounts.list();
    const enabled = views.filter((v) => v.enabled && v.configured);
    const result: ExchangeAdapter[] = [];
    for (const view of enabled) {
      // 过滤掉尚未实现下单能力的适配器（如只读阶段的合约适配器），
      // 否则会拿只读取器去下单而报出误导性错误
      if (!this.isSupported(view.exchange)) continue;
      const adapter = await this.get(view.exchange);
      if (adapter.supportsTrading === false) continue;
      result.push(adapter);
    }
    return result;
  }

  /** 该交易所码是否有对应适配器实现（防止新增交易所码后遍历时取到未实现的适配器） */
  isSupported(code: ExchangeCode): boolean {
    return IMPLEMENTED_EXCHANGES.includes(code);
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
