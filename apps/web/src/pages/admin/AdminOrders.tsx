import { useMemo, useState } from 'react';
import { App as AntApp, Button, Empty, Segmented, Space, Table, Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { OrderDTO, OrderStatus } from '@ai-trader/shared';
import { useCancelOrder, useOrders, useOverview } from '@/api/hooks';
import { ModeTag, OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { OrderPanel } from '@/components/OrderPanel';
import { useRequireAuth } from '@/components/AuthGate';
import { formatPrice, formatQty, formatTime, formatUsd } from '@/utils/format';

const FILTERS = [
  { label: '全部', value: 'ALL' },
  { label: '进行中', value: 'OPEN' },
  { label: '已成交', value: 'FILLED' },
  { label: '已撤销', value: 'CANCELED' },
  { label: 'Agent 单', value: 'AGENT' },
];

export function AdminOrders() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('ALL');
  const [panel, setPanel] = useState<{ side: 'BUY' | 'SELL' } | null>(null);
  const { message } = AntApp.useApp();
  const cancel = useCancelOrder();
  const { run: requireAuth, modal } = useRequireAuth();
  const { data: overview } = useOverview();

  const params = useMemo(() => {
    if (filter === 'AGENT') return { page, pageSize: 20, source: 'agent' };
    if (filter === 'OPEN') return { page, pageSize: 20, status: 'NEW' as OrderStatus };
    if (filter === 'FILLED' || filter === 'CANCELED') {
      return { page, pageSize: 20, status: filter as OrderStatus };
    }
    return { page, pageSize: 20 };
  }, [filter, page]);

  const { data, isLoading } = useOrders(params);

  const quoteFree =
    overview?.balances?.filter((b) => b.asset === 'USDT').reduce((a, b) => a + b.free, 0) ?? 0;
  const baseFree =
    overview?.balances?.filter((b) => b.asset === 'BTC').reduce((a, b) => a + b.free, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <Space wrap>
          <Segmented value={filter} onChange={(v) => { setFilter(String(v)); setPage(1); }} options={FILTERS} />
          <span className="muted-text">共 {data?.total ?? 0} 条</span>
        </Space>
        <Space>
          <Tooltip title="买入 BTC">
            <Button
              icon={<PlusOutlined />}
              onClick={() => setPanel({ side: 'BUY' })}
              className="!border-up/35 !bg-up/12 !text-up"
            >
              买入
            </Button>
          </Tooltip>
          <Tooltip title="卖出 BTC">
            <Button danger onClick={() => setPanel({ side: 'SELL' })}>
              卖出
            </Button>
          </Tooltip>
        </Space>
      </div>

      <div className="glass-card p-4">
        <Table<OrderDTO>
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={data?.items ?? []}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: data?.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          locale={{ emptyText: <Empty description="暂无订单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (v: string) => <span className="num text-[11px] text-muted">{formatTime(v)}</span>,
            },
            { title: '交易对', dataIndex: 'symbol', width: 110 },
            {
              title: '方向',
              dataIndex: 'side',
              width: 80,
              render: (v: 'BUY' | 'SELL') => <SideTag side={v} />,
            },
            {
              title: '类型',
              dataIndex: 'type',
              width: 80,
              render: (v: string) => (v === 'MARKET' ? '市价' : '限价'),
            },
            {
              title: '委托价',
              dataIndex: 'price',
              width: 120,
              align: 'right',
              render: (v: number) => <span className="num">{formatPrice(v)}</span>,
            },
            {
              title: '数量',
              dataIndex: 'quantity',
              width: 140,
              align: 'right',
              render: (v: number) => <span className="num">{formatQty(v)} BTC</span>,
            },
            {
              title: '成交均价',
              dataIndex: 'filledPrice',
              width: 120,
              align: 'right',
              render: (v: number) => <span className="num text-subtle">{v > 0 ? formatPrice(v) : '--'}</span>,
            },
            {
              title: '金额',
              dataIndex: 'quoteAmount',
              width: 120,
              align: 'right',
              render: (v: number) => <span className="num text-white">{formatUsd(v)}</span>,
            },
            {
              title: '来源',
              dataIndex: 'source',
              width: 100,
              render: (v: string) =>
                v === 'agent' ? <span className="text-btc-light">Agent</span> : <span className="text-subtle">手动</span>,
            },
            {
              title: '模式',
              dataIndex: 'mode',
              width: 100,
              render: (v: OrderDTO['mode']) => <ModeTag mode={v} />,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 110,
              render: (v: OrderStatus) => <OrderStatusTag status={v} />,
            },
            {
              title: '操作',
              key: 'action',
              width: 90,
              fixed: 'right',
              render: (_, row) =>
                row.status === 'NEW' || row.status === 'PARTIALLY_FILLED' ? (
                  <Button
                    size="small"
                    danger
                    type="text"
                    loading={cancel.isPending}
                    onClick={() =>
                      requireAuth(() => {
                        cancel.mutate(row.id, {
                          onSuccess: () => message.success('撤单成功'),
                          onError: (err) => message.error(err.message),
                        });
                      })
                    }
                  >
                    撤单
                  </Button>
                ) : (
                  <span className="text-[11px] text-muted">{row.error ? '失败' : '--'}</span>
                ),
            },
          ]}
        />
      </div>

      <OrderPanel
        open={Boolean(panel)}
        onClose={() => setPanel(null)}
        side={panel?.side ?? 'BUY'}
        price={overview?.ticker?.price ?? 0}
        quoteFree={quoteFree}
        baseFree={baseFree}
        mode={overview?.mode}
        exchange={overview?.balances?.[0]?.exchange}
      />
      {modal}
    </div>
  );
}
