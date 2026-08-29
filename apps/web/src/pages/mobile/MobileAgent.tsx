import { useState } from 'react';
import { Button, Empty, Spin, Switch, Tag, App as AntApp } from 'antd';
import { Bot, PlayCircle, RefreshCw } from 'lucide-react';
import { useAgentState, useDecisions, useToggleAgent, useRunAgent } from '@/api/hooks';
import { RUN_MODE_LABELS } from '@ai-trader/shared';
import { ActionTag } from '@/components/OrderStatusTag';
import { formatRelative, formatTime } from '@/utils/format';
import { useRequireAuth } from '@/components/AuthGate';

/** 移动端 Agent 页：启停、手动决策、最近决策流水 */
export function MobileAgent() {
  const { data, isLoading } = useAgentState();
  const { data: decisions, isLoading: loadingDecisions } = useDecisions({ pageSize: 10 });
  const toggle = useToggleAgent();
  const run = useRunAgent();
  const { message } = AntApp.useApp();
  const { run: requireAuth, modal } = useRequireAuth();
  const [busy, setBusy] = useState(false);

  if (isLoading && !data) {
    return (
      <div className="flex justify-center py-16">
        <Spin />
      </div>
    );
  }

  const config = data?.config;

  const onToggle = (checked: boolean) =>
    requireAuth(() => {
      toggle.mutate(checked, {
        onSuccess: () => message.success(checked ? 'Agent 已启动' : 'Agent 已停止'),
        onError: (err) => message.error(err.message),
      });
    });

  const onRun = () =>
    requireAuth(async () => {
      setBusy(true);
      try {
        const summary = await run.mutateAsync();
        message.success(`决策完成：${summary.action}（置信度 ${(summary.confidence * 100).toFixed(0)}%）`);
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    });

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-card p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-medium text-white">
            <Bot size={16} className="text-btc-light" /> {config?.name ?? 'Agent'}
          </span>
          <Switch checked={config?.enabled ?? false} onChange={onToggle} loading={toggle.isPending} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
          <Field label="运行模式" value={RUN_MODE_LABELS[config?.mode ?? 'dry_run']} />
          <Field label="决策周期" value={`${config?.decisionIntervalSec ?? 0} 秒`} />
          <Field label="交易对" value={config?.symbol ?? '--'} />
          <Field label="仓位比例" value={`${((config?.positionPct ?? 0) * 100).toFixed(0)}%`} />
          <Field label="模型" value={data?.llmAvailable ? (config?.model ?? '--') : '未配置（降级）'} />
          <Field label="最近运行" value={data?.lastRunAt ? formatRelative(data.lastRunAt) : '尚未运行'} />
        </div>
        <Button
          block
          size="large"
          icon={<PlayCircle size={16} />}
          loading={busy || run.isPending}
          onClick={onRun}
          className="!mt-4 !border-btc/40 !bg-btc/12 !text-btc-light"
        >
          立即执行一次决策
        </Button>
      </section>

      <section className="glass-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="section-title">最近决策</span>
          <RefreshCw size={13} className="text-muted" />
        </div>
        {loadingDecisions && !decisions ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : null}
        {decisions?.items.length ? (
          <div className="flex flex-col gap-2.5">
            {decisions.items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ActionTag action={item.action} />
                    <span className="num text-[11px] text-btc-light">
                      {(item.confidence * 100).toFixed(0)}%
                    </span>
                    {item.degraded ? <Tag color="orange">降级</Tag> : null}
                  </div>
                  <span className="text-[10px] text-muted">{formatTime(item.createdAt)}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-subtle">
                  {item.reason}
                </p>
                {!item.riskPassed ? (
                  <div className="mt-1.5 text-[10px] text-warn">
                    风控拦截：{item.riskRejectedBy}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          !loadingDecisions && <Empty description="暂无决策记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </section>
      {modal}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="mt-0.5 text-white/90">{value}</div>
    </div>
  );
}
