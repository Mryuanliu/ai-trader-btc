import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * 飞书推送客户端（自建应用，走开放平台 REST，不使用 @larksuiteoapi/node-sdk）。
 *
 * 为什么不走官方 SDK：
 *   本项目为访问币安设了 HTTPS_PROXY/HTTP_PROXY 环境变量,SDK 内部拉 tenant_access_token
 *   时不吃外层 httpInstance 的 proxy:false,axios 会走 http agent 处理 https 请求,
 *   直接抛 ERR_INVALID_PROTOCOL,推送失败。飞书是国内域名,裸 axios + proxy:false 最稳。
 *
 * 缺 FEISHU_APP_ID/APP_SECRET 时 isConfigured()=false,上层通知服务整体 no-op,
 * 与主交易链路完全解耦,绝不影响下单/结算。
 */
@Injectable()
export class FeishuService {
  private readonly logger = new Logger(FeishuService.name);
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly http: AxiosInstance;
  private tokenCache?: { token: string; expiresAt: number };
  private tokenPromise?: Promise<string>;

  constructor(config: ConfigService) {
    this.appId = config.get<string>('FEISHU_APP_ID') ?? '';
    this.appSecret = config.get<string>('FEISHU_APP_SECRET') ?? '';
    // proxy:false 让 axios 无视 HTTP_PROXY/HTTPS_PROXY 环境变量(飞书直连即可)
    this.http = axios.create({ proxy: false, timeout: 10_000 });
    if (this.appId && this.appSecret) {
      this.logger.log(`Feishu push client initialized (app ${this.appId.slice(0, 6)}***)`);
    }
  }

  isConfigured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  /** 向指定群 chat_id 发一张 Markdown 交互卡片 */
  async sendCard(chatId: string, markdown: string): Promise<void> {
    if (!this.isConfigured()) return;
    const token = await this.getTenantToken();
    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: this.limitCardContent(markdown) }],
    });
    const res = await this.http.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' } },
    );
    const code = res.data?.code;
    if (code && code !== 0) {
      throw new Error(`Feishu API ${code}: ${res.data?.msg || 'request failed'}`);
    }
  }

  /**
   * 回复指定消息（卡片形式）：对话机器人对来消息的应答通道。
   * 与 sendCard 同一张卡片组装/截断逻辑，只是 REST 换成 /messages/{id}/reply。
   */
  async replyMessage(messageId: string, markdown: string): Promise<void> {
    if (!this.isConfigured()) return;
    const token = await this.getTenantToken();
    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: this.limitCardContent(markdown) }],
    });
    const res = await this.http.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { msg_type: 'interactive', content },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' } },
    );
    const code = res.data?.code;
    if (code && code !== 0) {
      throw new Error(`Feishu reply API ${code}: ${res.data?.msg || 'request failed'}`);
    }
  }

  /**
   * tenant_access_token 有效期 ~2h,缓存到剩 60s 前复用。
   * 并发去重:同一时刻多次调用共享一次 fetch。
   */
  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) return this.tokenCache.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.http
        .post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          app_id: this.appId,
          app_secret: this.appSecret,
        })
        .then((res) => {
          const data = res.data;
          if (!data || data.code !== 0 || !data.tenant_access_token) {
            throw new Error(`Feishu token error: code=${data?.code} msg=${data?.msg}`);
          }
          const ttlMs = Math.max(60_000, Number(data.expire ?? 7200) * 1000);
          this.tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + ttlMs };
          return this.tokenCache.token;
        })
        .finally(() => {
          this.tokenPromise = undefined;
        });
    }
    return this.tokenPromise;
  }

  /** 卡片内容字节上限保护(与 muse-studio 同口径,防止超长 Markdown 触发 API 报错) */
  private limitCardContent(text: string): string {
    const suffix = '\n\n内容过长,后续部分已省略。';
    const maxBytes = 28 * 1024;
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let result = text;
    while (Buffer.byteLength(`${result}${suffix}`, 'utf8') > maxBytes && result.length > 0) {
      result = result.slice(0, Math.max(1, result.length - 512));
    }
    return `${result}${suffix}`;
  }
}
