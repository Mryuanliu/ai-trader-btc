import { describe, expect, it, vi } from 'vitest';
import type { TradingToolsService } from './tools/trading-tools.service';
import { ConfirmationStore, PendingAction } from './confirmation.store';

function build() {
  const executeWrite = vi.fn().mockResolvedValue('ok');
  const tools = { executeWrite } as unknown as TradingToolsService;
  return { svc: new ConfirmationStore(tools), executeWrite };
}

const stop: PendingAction = { tool: 'stop_strategy', args: {}, label: '停止全部策略实例（持仓保留）' };
const close: PendingAction = { tool: 'close_basket', args: {}, label: '一键平掉当前 OPEN 篮子' };

describe('ConfirmationStore', () => {
  it('push → confirm：经 executeWrite 逐条执行并汇总结果', async () => {
    const { svc, executeWrite } = build();
    svc.push('oc_1', stop);
    svc.push('oc_1', close); // 同批合并（一轮多个 tool_calls）
    const text = await svc.confirm('oc_1');
    expect(executeWrite).toHaveBeenCalledWith('stop_strategy', {});
    expect(executeWrite).toHaveBeenCalledWith('close_basket', {});
    expect(text).toContain('停止全部策略实例');
    expect(text).toContain('一键平掉当前 OPEN 篮子');
    // 确认即消费：再次 confirm 无待确认操作
    await expect(svc.confirm('oc_1')).resolves.toContain('没有待确认');
  });

  it('过期意图不执行，confirm 返回重新发起提示', async () => {
    const { svc, executeWrite } = build();
    svc.push('oc_1', stop);
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.now()) // push 内 expiresAt 计算保持不变
      .mockReturnValue(Date.now() + 61_000);
    await expect(svc.confirm('oc_1')).resolves.toContain('请重新发起');
    expect(executeWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('cancel：有待确认时作废并提示，无则原样提示', () => {
    const { svc } = build();
    expect(svc.cancel('oc_2')).toContain('当前没有待确认');
    svc.push('oc_2', stop);
    expect(svc.cancel('oc_2')).toContain('已取消');
    expect(svc.hasPending('oc_2')).toBe(false);
  });

  it('不同 chat 隔离：A 群的确认不影响 B 群', async () => {
    const { svc } = build();
    svc.push('oc_A', stop);
    expect(svc.hasPending('oc_B')).toBe(false);
    await expect(svc.confirm('oc_B')).resolves.toContain('没有待确认');
    expect(svc.hasPending('oc_A')).toBe(true);
  });

  it('buildConfirmCard 包含操作清单与确认/取消指引', () => {
    const card = ConfirmationStore.buildConfirmCard([stop, close]);
    expect(card).toContain('停止全部策略实例');
    expect(card).toContain('回复「确认」执行');
    expect(card).toContain('60 秒未确认自动作废');
  });
});
