import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { FeishuService } from './feishu.service';
import type { FeishuAgentService } from './feishu-agent.service';
import type { ConfirmationStore } from './confirmation.store';
import type { FeishuMessageReceiptEntity } from './entities/feishu-message-receipt.entity';
import { FeishuBotService } from './feishu-bot.service';

function build(overrides: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {
    FEISHU_BOT_ENABLED: 'true',
    FEISHU_APP_ID: 'cli_x',
    FEISHU_APP_SECRET: 'secret',
    FEISHU_CHAT_ID: 'oc_owner',
    LLM_ENABLED: 'true',
    LLM_API_KEY: 'sk-x',
    ...overrides,
  };
  const config = { get: (k: string, d?: string) => store[k] ?? d } as unknown as ConfigService;
  const replyMessage = vi.fn().mockResolvedValue(undefined);
  const sendCard = vi.fn().mockResolvedValue(undefined);
  const feishu = { replyMessage, sendCard } as unknown as FeishuService;
  const ask = vi.fn().mockResolvedValue({ answer: '今日净盈亏 12.3 USDT', pendingActions: [] });
  const resetSession = vi.fn().mockResolvedValue(undefined);
  const agent = { ask, resetSession } as unknown as FeishuAgentService;
  const confirm = vi.fn().mockResolvedValue('【操作执行结果】\n· 已停止');
  const cancel = vi.fn().mockReturnValue('已取消待确认的操作。');
  const confirmation = { confirm, cancel } as unknown as ConfirmationStore;
  const insert = vi.fn().mockResolvedValue(undefined);
  const receiptRepo = { insert } as unknown as Repository<FeishuMessageReceiptEntity>;
  const svc = new FeishuBotService(config, feishu, agent, confirmation, receiptRepo);
  return { svc, insert, replyMessage, sendCard, ask, resetSession, confirm, cancel, agent };
}

function event(text: string, over: Record<string, unknown> = {}) {
  // sender/tenant_key 覆盖顶层字段，其余（chat_id/message_type…）覆盖 message 字段
  const { sender, tenant_key, ...msgOver } = over;
  return {
    tenant_key: tenant_key ?? 'tk',
    sender: sender ?? { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
    message: {
      message_id: `om_${Math.random()}`,
      chat_id: 'oc_owner',
      message_type: 'text',
      content: JSON.stringify({ text }),
      ...msgOver,
    },
  } as never;
}

/** enqueue 是内部管道，测试直接调私有入口（不建 WS 连接） */
const feed = (svc: FeishuBotService, data: never) =>
  (svc as unknown as { enqueue: (d: never) => Promise<void> }).enqueue(data);
/** 等指定 chat 的串行链尾跑完（代替拍脑袋 sleep，防 flaky） */
const drain = async (svc: FeishuBotService, key = 'tk:oc_owner') => {
  const queues = (svc as unknown as { queues: Map<string, Promise<void>> }).queues;
  for (let i = 0; i < 5 && queues.has(key); i++) await queues.get(key);
};

describe('FeishuBotService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('正常文本：去重入库 → ack → agent.ask → 回复答案', async () => {
    const { svc, insert, replyMessage, ask } = build();
    await feed(svc, event('@_user_1 今天收益怎样'));
    await drain(svc);
    expect(insert).toHaveBeenCalledWith({ messageId: expect.any(String), tenantKey: 'tk' });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'tk', chatId: 'oc_owner', text: '今天收益怎样' }),
    );
    const replies = replyMessage.mock.calls.map((c) => String(c[1]));
    expect(replies.some((r) => r.includes('已收到'))).toBe(true);
    expect(replies.some((r) => r.includes('12.3'))).toBe(true);
  });

  it('receipt 主键冲突（飞书重投）直接丢弃', async () => {
    const { svc, insert, ask } = build();
    insert.mockRejectedValueOnce(new Error('duplicate key'));
    await feed(svc, event('重复消息'));
    await drain(svc);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it('忽略 bot 自身消息与非文本消息', async () => {
    const { svc, ask } = build();
    await feed(svc, event('回环', { sender: { sender_type: 'app' } }));
    await feed(svc, event('图片', { message_type: 'image' }));
    await drain(svc);
    expect(ask).not.toHaveBeenCalled();
  });

  it('非白名单群不响应', async () => {
    const { svc, ask } = build();
    await feed(svc, event('hey', { chat_id: 'oc_stranger' }));
    await drain(svc, 'tk:oc_stranger');
    expect(ask).not.toHaveBeenCalled();
  });

  it('「确认/取消」裸词不进 LLM，直接走确认流', async () => {
    const { svc, ask, confirm, cancel, replyMessage } = build();
    await feed(svc, event('确认'));
    await feed(svc, event('取消'));
    await drain(svc);
    expect(confirm).toHaveBeenCalledWith('oc_owner');
    expect(cancel).toHaveBeenCalledWith('oc_owner');
    expect(ask).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledWith(expect.any(String), '【操作执行结果】\n· 已停止');
  });

  it('/new 清会话并回执', async () => {
    const { svc, ask, resetSession, replyMessage } = build();
    await feed(svc, event('/new'));
    await drain(svc);
    expect(resetSession).toHaveBeenCalledWith('tk', 'oc_owner');
    expect(ask).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('新会话'));
  });

  it('写操作被拦截时追加确认卡', async () => {
    const pending = [{ tool: 'stop_strategy', args: {}, label: '停止全部策略实例（持仓保留）' }];
    const { svc, agent, sendCard } = build();
    agent.ask = vi
      .fn()
      .mockResolvedValue({ answer: '已提交确认，请回复「确认」执行。', pendingActions: pending });
    await feed(svc, event('停掉策略'));
    await drain(svc);
    expect(sendCard).toHaveBeenCalledWith('oc_owner', expect.stringContaining('需要确认的操作'));
    expect(sendCard).toHaveBeenCalledWith('oc_owner', expect.stringContaining('停止全部策略实例'));
  });

  it('LLM 未配置时回复启用指引，不进 agent', async () => {
    const { svc, ask, replyMessage } = build({ LLM_API_KEY: '' });
    await feed(svc, event('在吗'));
    await drain(svc);
    expect(ask).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('未启用'));
  });
});
