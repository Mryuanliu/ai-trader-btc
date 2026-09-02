import { useMemo, useState } from 'react';
import { App as AntApp, Button, Empty, Segmented, Space, Table, Tag, Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { OrderDTO, OrderStatus } from '@ai-trader/shared';
import { useAllLots, useCancelOrder, useOrders, useOverview, useRoundTrips } from '@/api/hooks';
import { ModeTag, OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { OrderCalendar } from '@/components/OrderCalendar';
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
  const [market, setMarket] = useState<'futures'>('futures');
  /** 视图：列表 / 日历（按天分类） */
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const { message } = AntApp.useApp();
  const cancel = useCancelOrder();
  const { run: requireAuth, modal } = useRequireAuth();
  const { data: overview } = useOverview();

  const params = useMemo(() => {
    // 市场过滤必须作用到订单列表本身：现货/合约共用订单表，
    // 不隔离时合约大单会混进现货 tab，按现货口径加总对不上持仓
    const base: Record<string, unknown> = { page, pageSize: 20, market };
    if (filter === 'AGENT') return { ...base, source: 'agent' };
    if (filter === 'OPEN') return { ...base, status: 'NEW' as OrderStatus };
    if (filter === 'FILLED' || filter === 'CANCELED') {
      return { ...base, status: filter as OrderStatus };
    }
    return base;
  }, [filter, page, market]);

  const { data, isLoading } = useOrders(params);
  // 回合盈亏：把「开仓→平仓」配对，平仓单才能显示赚了多少（开仓单本身无盈亏概念）
  const { data: rt, isLoading: rtLoading } = useRoundTrips(market);
  // 全量 Lot：订单行可关联到仓位单（平仓单显示开仓价/TP/SL/盈亏，开仓单标记所属 Lot）
  const { data: allLots = [] } = useAllLots({ market });

  /** 平仓订单 ID → 该回合盈亏；开仓单查不到 → 显示 -- */
  const pnlByOrder = useMemo(() => {
    const m = new Map<string, { netPnl: number; returnPct: number }>();
    for (const t of rt?.trips ?? []) {
      if (t.closeOrderId) m.set(t.closeOrderId, { netPnl: t.netPnl, returnPct: t.returnPct });
    }
    return m;
  }, [rt]);

  // 平仓订单 ID → 对应 Lot（用 closeOrderId 精确关联，优于 FIFO 启发式回合）
  const lotByCloseOrder = useMemo(() => {
    const m = new Map<string, (typeof allLots)[number]>();
    for (const lot of allLots) {
      if (lot.closeOrderId) m.set(lot.closeOrderId, lot);
    }
    return m;
  }, [allLots]);

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <Space wrap>
          <Tag color="purple">合约</Tag>
          <Segmented value={filter} onChange={(v) => { setFilter(String(v)); setPage(1); }} options={FILTERS} />
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as 'list' | 'calendar')}
            options={[
              { label: '列表', value: 'list' },
              { label: '日历', value: 'calendar' },
            ]}
          />
          <span className="muted-text">共 {data?.total ?? 0} 条</span>
        </Space>
        <span className="muted-text text-[12px]">合约订单 · 手动下单请到「合约」页</span>
      </div>

      {view === 'calendar' ? (
        <OrderCalendar market={market} />
      ) : null}

      {view === 'list' && rt && rt.summary.count > 0 ? (
        <div className="glass-card flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
          <span className="text-[13px] font-medium">合约回合盈亏</span>
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

      {view === 'list' ? (
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
              title: '盈亏',
              key: 'lotPnl',
              width: 120,
              align: 'right',
              render: (_, row) => {
                // 优先用 Lot 精确关联：平仓单显示该 Lot 的净盈亏与收益率
                const lot = lotByCloseOrder.get(row.id);
                if (lot) {
                  return <PnlCell netPnl={lot.realizedPnl ?? 0} returnPct={lot.returnPct ?? 0} />;
                }
                // 回退到 FIFO 回合（Lot 建仓前的老数据）
                const hit = pnlByOrder.get(row.id);
                if (!hit) return <span className="text-[11px] text-muted">--</span>;
                return <PnlCell netPnl={hit.netPnl} returnPct={hit.returnPct} />;
              },
            },
            {
              title: '止盈止损',
              key: 'lotTpSl',
              width: 120,
              align: 'right',
              render: (_, row) => {
                const lot = lotByCloseOrder.get(row.id);
                if (!lot) return <span className="text-[11px] text-muted">--</span>;
                return (
                  <div className="flex flex-col items-end leading-tight text-[10px] text-subtle">
                    <span>开仓 {formatPrice(lot.entryPrice)}</span>
                    <span>SL {(lot.stopLossPct * 100).toFixed(1)}% / TP {(lot.takeProfitPct * 100).toFixed(1)}%</span>
                  </div>
                );
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
      ) : null}

      {modal}
    </div>
  );
}
