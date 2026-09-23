import { useState } from 'react';
import { Button, Empty, Spin, Tag, App as AntApp } from 'antd';
import { Bot, PlayCircle, PowerOff } from 'lucide-react';
import {
  useFuturesConfig,
  useStartStrategy,
  useStopStrategy,
  useStrategies,
  useStrategyStatus,
} from '@/api/hooks';
import { RUN_MODE_LABELS, type RunMode } from '@ai-trader/shared';
import { formatTime } from '@/utils/format';
import { useRequireAuth } from '@/components/AuthGate';

/**
 * 移动端「策略」页。
 *
 * 替代原「Agent」页（展示决策流水）——平台不再有决策引擎，
 * 这里改为：查看策略运行状态 + 启动/停止策略。
 * 存在未平仓仓位单时启动会被拦下，列出明细要求先手动平掉。
 */
export function MobileStrategy() {
  const { data: config } = useFuturesConfig();
  const { data: status, isLoading } = useStrategyStatus(5000);
  const { data: strategies } = useStrategies();
  const start = useStartStrategy();
  const stop = useStopStrategy();
  const { message, modal } = AntApp.useApp();
  const { run: requireAuth } = useRequireAuth();
  const [busyId, setBusyId] = useState<string | null>(null);

  const running = status?.running ?? false;
  const peak =
    status?.state && typeof status.state.basketPeakPct === 'number'
      ? `${(status.state.basketPeakPct * 100).toFixed(2)}%`
      : '--';
  const note = status?.state && typeof status.state.note === 'string' ? status.state.note : '';

  /** 实盘启动前的二次确认（与后台策略页保持一致） */
  const confirmLiveIfNeeded = (onOk: () => void) => {
    if (config?.mode !== 'live') {
      onOk();
      return;
    }
    modal.confirm({
      title: '以实盘模式启动策略？',
      width: '86%',
      content: (
        <div className="text-[12px] leading-relaxed">
          当前为 <b>live（实盘）</b>，启动后策略将用真实资金自动下单。
        </div>
      ),
      okText: '确认启动',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk,
    });
  };

  const onStart = (name: string, label: string) =>
    confirmLiveIfNeeded(() => requireAuth(async () => {
      setBusyId(name);
      try {
        const result = await start.mutateAsync({ name });
        if (!result.ok) {
          if (result.blockingLots?.length) {
            modal.warning({
              title: '还有仓位单未平仓',
              okText: '知道了',
              content: (
                <div className="text-[12px] leading-relaxed">
                  <div className="mb-2 text-muted">{result.message}</div>
                  {result.blockingLots.map((lot) => (
                    <div
                      key={lot.id}
                      className="flex items-center justify-between border-t border-white/10 py-1.5"
                    >
                      <span>
                        {lot.direction === 'LONG' ? '多' : '空'} {lot.quantity.toFixed(6)}
                      </span>
                      <span className={lot.unrealizedPnl >= 0 ? 'text-up' : 'text-down'}>
                        {lot.unrealizedPnl.toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              ),
            });
            return;
          }
          message.error(result.message);
          return;
        }
        message.success(`${label} 已启动`);
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setBusyId(null);
      }
    }));

  const onStop = () =>
    requireAuth(async () => {
      try {
        await stop.mutateAsync();
        message.success('策略已停止，持仓保留需手动处理');
      } catch (err) {
        message.error((err as Error).message);
      }
    });

  if (isLoading && !status) {
    return (
      <div className="flex justify-center py-16">
        <Spin />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 运行状态 */}
      <section className="glass-card p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-medium text-white">
            <Bot size={16} className="text-btc-light" />
            {running ? (status?.label ?? '策略运行中') : '未运行策略'}
          </span>
          {running ? (
            <Button
              size="small"
              danger
              icon={<PowerOff size={14} />}
              loading={stop.isPending}
              onClick={onStop}
            >
              停止
            </Button>
          ) : (
            <Tag>未运行</Tag>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
          <Field label="运行模式" value={RUN_MODE_LABELS[(config?.mode as RunMode) ?? 'dry_run']} />
          <Field label="交易对" value={config?.symbol ?? '--'} />
          <Field label="杠杆" value={`${config?.leverage ?? 0}x`} />
          <Field label="未完结仓位单" value={String(status?.openLotCount ?? 0)} />
          <Field label="篮子收益峰值" value={peak} />
          <Field label="最近 tick" value={status?.lastTickAt ? formatTime(status.lastTickAt) : '--'} />
        </div>

        {note ? <div className="mt-3 text-[11px] text-subtle">最近动作：{note}</div> : null}
        {status?.lastError ? (
          <div className="mt-2 text-[10px] text-warn">最近一次 tick 失败：{status.lastError}</div>
        ) : null}
      </section>

      {/* 策略合集 */}
      <section className="glass-card p-4">
        <div className="mb-3 section-title">可用策略</div>
        {strategies?.length ? (
          <div className="flex flex-col gap-2.5">
            {strategies.map((s) => (
              <div
                key={s.name}
                className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-white">{s.label}</span>
                  <Button
                    size="small"
                    type="text"
                    disabled={running}
                    loading={busyId === s.name}
                    icon={<PlayCircle size={14} />}
                    onClick={() => onStart(s.name, s.label)}
                    className="!text-btc-light"
                  >
                    启动
                  </Button>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-subtle">
                  {s.description}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <Empty description="暂无可用策略" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        <div className="mt-3 text-[10px] text-muted">
          同一时间只能运行一个策略；启动前需先平掉所有未完结仓位单
        </div>
      </section>
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
