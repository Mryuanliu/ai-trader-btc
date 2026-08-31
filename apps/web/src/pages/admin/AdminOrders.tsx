import { useMemo, useState } from 'react';
import { App as AntApp, Button, Empty, Segmented, Space, Table, Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { OrderDTO, OrderStatus } from '@ai-trader/shared';
import { useCancelOrder, useOrders, useOverview, useRoundTrips } from '@/api/hooks';
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

/** 回合盈亏单元格：正绿负红，主行净盈亏、副行收益率 */
function PnlCell({ netPnl, returnPct }: { netPnl: number; returnPct: number }) {
  const color = netPnl > 0 ? 'text-up' : netPnl < 0 ? 'text-down' : 'text-subtle';
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={`num ${color}`}>
        {netPnl > 0 ? '+' : ''}
        {formatUsd(netPnl)}
      </span>
      <span className={`num text-[10px] ${color}`}>
        {returnPct > 0 ? '+' : ''}
        {(returnPct * 100).toFixed(2)}%
      </span>
    </div>
  );
}

export function AdminOrders() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('ALL');
  const [market, setMarket] = useState<'spot' | 'futures'>('spot');
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
  // 回合盈亏：把「开仓→平仓」配对，平仓单才能显示赚了多少（开仓单本身无盈亏概念）
  const { data: rt, isLoading: rtLoading } = useRoundTrips(market);

  /** 平仓订单 ID → 该回合盈亏；开仓单查不到 → 显示 -- */
  const pnlByOrder = useMemo(() => {
    const m = new Map<string, { netPnl: number; returnPct: number }>();
    for (const t of rt?.trips ?? []) {
      if (t.closeOrderId) m.set(t.closeOrderId, { netPnl: t.netPnl, returnPct: t.returnPct });
    }
    return m;
  }, [rt]);

  const quoteFree =
    overview?.balances?.filter((b) => b.asset === 'USDT').reduce((a, b) => a + b.free, 0) ?? 0;
  const baseFree =
    overview?.balances?.filter((b) => b.asset === 'BTC').reduce((a, b) => a + b.free, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <Space wrap>
          <Segmented
            size="small"
            value={market}
            onChange={(v) => setMarket(v as 'spot' | 'futures')}
            options={[
              { label: '现货', value: 'spot' },
              { label: '合约', value: 'futures' },
            ]}
          />
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

      {rt && rt.summary.count > 0 ? (
        <div className="glass-card flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
          <span className="text-[13px] font-medium">
            {market === 'spot' ? '现货' : '合约'}回合盈亏
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">已实现净盈亏</span>
            <span
              className={`num text-[16px] font-semibold ${
                rt.summary.totalNetPnl > 0 ? 'text-up' : rt.summary.totalNetPnl < 0 ? 'text-down' : ''
              }`}
            >
              {rt.summary.totalNetPnl > 0 ? '+' : ''}
              {formatUsd(rt.summary.totalNetPnl)}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">回合</span>
            <span className="num">{rt.summary.count}</span>
            <span className="num text-[11px] text-up">盈 {rt.summary.wins}</span>
            <span className="num text-[11px] text-down">亏 {rt.summary.losses}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">胜率</span>
            <span className="num">{(rt.summary.winRate * 100).toFixed(1)}%</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">最佳</span>
            <span className="num text-up">+{formatUsd(rt.summary.bestPnl)}</span>
            <span className="text-[11px] text-muted ml-2">最差</span>
            <span className="num text-down">{formatUsd(rt.summary.worstPnl)}</span>
          </div>
          <Tooltip title="与持仓页的已实现盈亏同口径；开仓手续费在现货已摊入成本、合约计入总费用">
            <span className="text-[11px] text-muted underline decoration-dashed cursor-help">口径说明</span>
          </Tooltip>
        </div>
      ) : null}

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
              title: '回合盈亏',
              key: 'roundTripPnl',
              width: 110,
              align: 'right',
              render: (_, row) => {
                // 只有平仓单有回合盈亏（配对到它的开仓成本）；开仓单显示 --
                const hit = pnlByOrder.get(row.id);
                if (!hit) return <span className="text-[11px] text-muted">--</span>;
                return <PnlCell netPnl={hit.netPnl} returnPct={hit.returnPct} />;
              },
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
