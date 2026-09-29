import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { FeishuService } from './feishu.service';
import { FeishuMessageReceiptEntity } from './entities/feishu-message-receipt.entity';
import { FeishuAgentService } from './feishu-agent.service';
import { ConfirmationStore } from './confirmation.store';

/**
 * 飞书对话机器人：长连接收消息（WSClient）→ 幂等去重 → 白名单 → 按群串行 → LLM 工具循环。
 *
 * 复用 muse-studio 机器人管道的四个关键点（收发分离——发送走已上线的裸 axios FeishuService）：
 * 1. WSClient 长连接：不需要公网回调地址，本机即可跑；
 * 2. receipt 表去重：飞书对事件有重试投递，主键冲突即已处理，直接丢弃；
 * 3. 按 chat 串行队列：同一群的多条消息排队处理，防会话历史交错；
 * 4. 「确认/取消」裸词不进 LLM：写操作执行完全由服务端确认流接管。
 *
 * 全链路 no-op 守卫：FEISHU_BOT_ENABLED=false 或缺 APP_ID/SECRET 时不建连接，
 * 对交易主进程零影响。
 */
@Injectable()
export class FeishuBotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeishuBotService.name);
  private wsClient?: Lark.WSClient;
  /** 每个 chat 一条串行链：Map<queueKey, 链尾 Promise> */
  private readonly queues = new Map<string, Promise<void>>();
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly feishu: FeishuService,
    private readonly agent: FeishuAgentService,
    private readonly confirmation: ConfirmationStore,
    @InjectRepository(FeishuMessageReceiptEntity)
    private readonly receiptRepo: Repository<FeishuMessageReceiptEntity>,
  ) {}

  /** 应用启动完成后建长连接（未启用/缺配置直接 no-op） */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled()) return;
    const appId = this.config.get<string>('FEISHU_APP_ID', '');
    const appSecret = this.config.get<string>('FEISHU_APP_SECRET', '');
    if (!appId || !appSecret) {
      this.logger.warn('FEISHU_BOT_ENABLED=true 但缺 FEISHU_APP_ID/SECRET，机器人未启动');
      return;
    }

    // 长连接拉取 /callback/ws/endpoint 走这条 http 通道，必须自定义 httpInstance：
    // 1) proxy:false —— 本机为币安配了 HTTP(S)_PROXY，默认实例会被劫持，
    //    报 `Protocol "https:" not supported. Expected "http:"`；
    // 2) 响应拦截器返回 resp.data —— SDK 的 pullConnectConfig 直接解构
    //    {code,data,msg}，沿用默认实例才有的拆包拦截器，自定义实例须复刻，
    //    否则 code 恒为 undefined（表现为 `code: undefined, undefined` 连不上）。
    const httpInstance = axios.create({ proxy: false });
    httpInstance.interceptors.response.use((resp) => resp.data);

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // 事件必须立即 ACK，处理全部异步：错误在 handle 内部自吞并回复用户
        this.enqueue(data).catch((err) =>
          this.logger.error(`事件处理编排异常：${(err as Error).message}`),
        );
      },
    });

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      // axios 实例与 SDK 的 HttpInstance 泛型签名不同，结构兼容，此处显式 cast
      httpInstance: httpInstance as unknown as Lark.HttpInstance,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.logger.log('飞书对话机器人长连接已建立（im.message.receive_v1）');

    // 回执表每日清理 7 天前记录（只用于去重，无业务价值）
    this.pruneTimer = setInterval(() => {
      this.receiptRepo
        .delete({ createdAt: LessThan(new Date(Date.now() - 7 * 86_400_000)) })
        .catch(() => undefined);
    }, 24 * 3600_000);
    this.pruneTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    // WSClient 无公开 close：置空引用，进程退出即断开
    this.wsClient = undefined;
  }

  private enabled(): boolean {
    return this.config.get<string>('FEISHU_BOT_ENABLED', 'false') === 'true' ||
      this.config.get<boolean>('FEISHU_BOT_ENABLED') === true;
  }

  /** 白名单：FEISHU_BOT_ALLOWED_CHATS 逗号分隔；留空 = 仅推送群 FEISHU_CHAT_ID */
  private allowedChats(): Set<string> {
    const raw = this.config.get<string>('FEISHU_BOT_ALLOWED_CHATS', '');
    const list = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [this.config.get<string>('FEISHU_CHAT_ID', '')].filter(Boolean);
    return new Set(list);
  }

  private async enqueue(data: ReceiveMessageEvent): Promise<void> {
    const msg = data?.message;
    if (!msg?.message_id || !msg?.chat_id) return;
    const chatId = msg.chat_id;
    const tenantKey = data.tenant_key ?? data.app_id ?? 'default';
    const openId = data.sender?.sender_id?.open_id ?? '';

    // 1) 幂等去重：主键冲突 = 飞书重投，直接丢弃
    try {
      await this.receiptRepo.insert({ messageId: msg.message_id, tenantKey });
    } catch {
      return;
    }

    // 2) 过滤：只响应文本消息，忽略 bot 自身消息（防回环）
    if (data.sender?.sender_type === 'app') return;
    if (msg.message_type !== 'text') return;
    const allowed = this.allowedChats();
    if (allowed.size > 0 && !allowed.has(chatId)) {
      this.logger.debug(`非白名单群消息，忽略：${chatId}`);
      return;
    }

    // 去 @ 占位符（"@_user_1 今天收益怎样" → "今天收益怎样"）
    const text = extractText(msg.content).replace(/@_user_\d+\s*/g, '').trim();
    if (!text) return;

    // 3) 按 chat 串行：上一条处理完才处理下一条，会话历史不交错
    const key = `${tenantKey}:${chatId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.process({ tenantKey, chatId, openId, messageId: msg.message_id, text })).catch(() => undefined);
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async process(params: { tenantKey: string; chatId: string; openId: string; messageId: string; text: string }): Promise<void> {
    const { tenantKey, chatId, openId, messageId, text } = params;
    try {
      // 「确认/取消」裸词：不进 LLM，直接走确认流
      if (/^确\s*认$/.test(text)) {
        const result = await this.confirmation.confirm(chatId);
        await this.feishu.replyMessage(messageId, result);
        return;
      }
      if (/^取\s*消$/.test(text)) {
        await this.feishu.replyMessage(messageId, this.confirmation.cancel(chatId));
        return;
      }
      if (text === '/new' || text === '/reset') {
        await this.agent.resetSession(tenantKey, chatId);
        await this.feishu.replyMessage(messageId, '已开始新会话，历史已清空。');
        return;
      }

      if (!this.agentEnabled()) {
        await this.feishu.replyMessage(messageId, '对话能力未启用：请配置 LLM_API_KEY 并开启 LLM_ENABLED。');
        return;
      }

      await this.feishu.replyMessage(messageId, '已收到，正在查数据…');
      const res = await this.agent.ask({ tenantKey, chatId, openId, text });
      await this.feishu.replyMessage(messageId, res.answer);
      // 本轮有写操作被拦截：追加确认卡（独立消息，裸词「确认」在 bot 层截获）
      if (res.pendingActions.length > 0) {
        await this.feishu.sendCard(chatId, ConfirmationStore.buildConfirmCard(res.pendingActions));
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`消息处理失败（chat=${chatId}）：${message}`);
      await this.feishu
        .replyMessage(messageId, `处理失败：${message.slice(0, 200)}`)
        .catch(() => undefined);
    }
  }

  private agentEnabled(): boolean {
    return this.config.get<string>('LLM_ENABLED', 'true') !== 'false' &&
      Boolean(this.config.get<string>('LLM_API_KEY', ''));
  }
}

/** text 消息 content 是 JSON 字符串：{"text":"..."} */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? '';
  } catch {
    return '';
  }
}

/**
 * im.message.receive_v1 事件的结构类型（SDK 内联定义未导出具名类型，
 * 这里只声明我们用到的字段，事件数据按结构取用）。
 */
interface ReceiveMessageEvent {
  tenant_key?: string;
  app_id?: string;
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type: string;
    content: string;
  };
}
