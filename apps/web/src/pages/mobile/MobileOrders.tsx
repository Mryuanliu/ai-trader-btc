import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Empty, Segmented, Spin, App as AntApp } from 'antd';
import { useOrders, useCancelOrder } from '@/api/hooks';
import { OrderStatusTag, SideTag, ModeTag } from '@/components/OrderStatusTag';
import { formatPrice, formatQty, formatTime, formatUsd } from '@/utils/format';
import { useRequireAuth } from '@/components/AuthGate';
import { isOpenStatus } from '@ai-trader/shared';

const FILTERS = [
  { label: '全部', value: 'ALL' },
  { label: '进行中', value: 'OPEN' },
  { label: '已成交', value: 'FILLED' },
  { label: '已撤销', value: 'CANCELED' },
];

export function MobileOrders() {
  const [filter, setFilter] = useState('ALL');
  const params = useMemo(
    () => ({
      pageSize: 30,
      status: filter === 'ALL' ? undefined : filter === 'OPEN' ? 'NEW' : filter,
    }),
    [filter],
  );
  const { data, isLoading } = useOrders(params);
  const cancel = useCancelOrder();
  const { message } = AntApp.useApp();
  const { run, modal } = useRequireAuth();

  const orders = useMemo(() => {
    const rows = data?.items ?? [];
    if (filter === 'OPEN') return rows.filter((o) => isOpenStatus(o.status));
    return rows;
  }, [data?.items, filter]);

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        block
        size="small"
        value={filter}
        onChange={(v) => setFilter(String(v))}
        options={FILTERS}
      />

      {isLoading && orders.length === 0 ? (
        <div className="flex justify-center py-16">
          <Spin />
        </div>
      ) : null}

      {orders.length === 0 && !isLoading ? (
        <Empty description="暂无订单" image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-16" />
      ) : null}

      <div className="flex flex-col gap-2.5">
        {orders.map((order) => (
          <div key={order.id} className="glass-card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    'rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
                    order.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                  )}
                >
                  {order.side === 'BUY' ? '买入' : '卖出'}
                </span>
                <span className="text-[13px] text-white">{order.type === 'MARKET' ? '市价' : '限价'}</span>
                <ModeTag mode={order.mode} />
              </div>
              <OrderStatusTag status={order.status} />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-y-2 text-[11px]">
              <Field label="委托价" value={`${formatPrice(order.price)} USDT`} />
              <Field label="数量" value={`${formatQty(order.quantity)} BTC`} />
              <Field label="成交均价" value={`${formatPrice(order.filledPrice)} USDT`} />
              <Field label="金额" value={`${formatUsd(order.quoteAmount)} USDT`} />
              <Field label="来源" value={order.source === 'agent' ? 'Agent 自动' : '手动'} />
              <Field label="时间" value={formatTime(order.createdAt)} />
            </div>

            {isOpenStatus(order.status) ? (
              <button
                onClick={() =>
                  run(() => {
                    cancel.mutate(order.id, {
                      onSuccess: () => message.success('撤单成功'),
                      onError: (err) => message.error(err.message),
                    });
                  })
                }
                className="mt-3 w-full rounded-lg border border-down/30 bg-down/10 py-2 text-[12px] text-down active:scale-[0.99]"
              >
                撤销订单
              </button>
            ) : null}
            {order.error ? (
              <div className="mt-2 rounded-lg bg-down/10 px-2 py-1.5 text-[11px] text-down">
                {order.error}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {modal}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="num mt-0.5 text-white/90">{value}</div>
    </div>
  );
}
