import { useMemo, useState } from 'react';
import { Badge, Calendar, Card, Empty, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { OrderDTO, OrderStatus } from '@ai-trader/shared';
import { useOrders, useRoundTrips } from '@/api/hooks';
import { ModeTag, OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { formatPrice, formatQty, formatSignedUsd, formatTime, formatUsd } from '@/utils/format';

interface Props {
  market: 'spot' | 'futures';
}

/**
 * 订单日历：按月展示每日订单数与已实现盈亏。
 *
 * - 每格顶部 = 当天平仓回合的已实现净盈亏（正绿负红，用 closedAt 归日）
 * - 每格底部 = 当天订单笔数（含未成交）
 * - 点击某天 → 右侧/下方展示当天订单明细
 *
 * 数据：一次性拉取近 500 条订单 + 全部回合（按市场），前端按月切片。
 */
export function OrderCalendar({ market }: Props) {
  // 拉大分页覆盖近一个月（订单量小时 500 足够；量大时以最近 500 条为准）
  const { data: ordersData, isLoading } = useOrders({ page: 1, pageSize: 500, market });
  const { data: rt } = useRoundTrips(market);

  const orders = ordersData?.items ?? [];

  // 全部订单按 "YYYY-MM-DD" 归日
  const ordersByDay = useMemo(() => {
    const m = new Map<string, OrderDTO[]>();
    for (const o of orders) {
      const key = dayjs(o.createdAt).format('YYYY-MM-DD');
      const arr = m.get(key) ?? [];
      arr.push(o);
      m.set(key, arr);
    }
    return m;
  }, [orders]);

  // 回合按 closedAt 归日 → 每天已实现盈亏
  const pnlByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rt?.trips ?? []) {
      const key = dayjs(t.closedAt).format('YYYY-MM-DD');
      m.set(key, (m.get(key) ?? 0) + t.netPnl);
    }
    return m;
  }, [rt]);

  // 当前选中的某天明细
  const [selectedDay, setSelectedDay] = useState<Dayjs | null>(null);
  const selectedOrders = selectedDay
    ? ordersByDay.get(selectedDay.format('YYYY-MM-DD')) ?? []
    : [];
  const selectedPnl = selectedDay ? pnlByDay.get(selectedDay.format('YYYY-MM-DD')) ?? 0 : 0;

  // 当月已实现盈亏合计（用于面板提示）
  const monthPnl = useMemo(() => {
    const month = selectedDay?.format('YYYY-MM');
    if (!month) return 0;
    let sum = 0;
    for (const [day, v] of pnlByDay) if (day.startsWith(month)) sum += v;
    return sum;
  }, [pnlByDay, selectedDay]);

  const dateCellRender = (date: Dayjs) => {
    const key = date.format('YYYY-MM-DD');
    const pnl = pnlByDay.get(key) ?? 0;
    const count = ordersByDay.get(key)?.length ?? 0;
    return (
      <div className="flex h-full flex-col justify-between gap-0.5">
        <div className={pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-subtle'}>
          {pnl !== 0 ? <span className="num text-[11px] font-medium">{formatSignedUsd(pnl)}</span> : null}
        </div>
        {count > 0 ? (
          <Badge
            count={count}
            size="small"
            color={pnl > 0 ? '#16a34a' : pnl < 0 ? '#ef4444' : '#64748b'}
            overflowCount={99}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <Card
          size="small"
          title={
            <div className="flex items-center gap-3">
              <span className="text-[13px]">{market === 'spot' ? '现货' : '合约'}订单日历</span>
              <span className="text-[11px] text-muted">
                点击某天查看当日订单明细 · 绿色数字=当日已实现盈利 / 红色=亏损
              </span>
            </div>
          }
          extra={
            selectedDay ? (
              <span className="text-[11px] text-muted">当月已实现 {formatSignedUsd(monthPnl)}</span>
            ) : null
          }
        >
          <Calendar
            fullscreen={false}
            cellRender={dateCellRender}
            onSelect={(date) => setSelectedDay(date)}
            headerRender={({ value, onChange }) => (
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[13px] font-medium text-white">
                  {value.format('YYYY年 M月')}
                </span>
                <div className="flex gap-1">
                  <button className="cal-nav" onClick={() => onChange(value.subtract(1, 'month'))}>
                    上月
                  </button>
                  <button className="cal-nav" onClick={() => onChange(dayjs())}>
                    本月
                  </button>
                  <button className="cal-nav" onClick={() => onChange(value.add(1, 'month'))}>
                    下月
                  </button>
                </div>
              </div>
            )}
          />
        </Card>

        {/* 选中日期的订单明细 */}
        <Card
          size="small"
          title={
            selectedDay ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px]">{selectedDay.format('M月D日')} 订单</span>
                <span
                  className={`num text-[12px] ${
                    selectedPnl > 0 ? 'text-up' : selectedPnl < 0 ? 'text-down' : 'text-subtle'
                  }`}
                >
                  {formatSignedUsd(selectedPnl)}
                </span>
              </div>
            ) : (
              <span className="text-[13px]">点击左侧日期查看明细</span>
            )
          }
        >
          <div className="max-h-[420px] overflow-auto">
            <Table<OrderDTO>
              size="small"
              rowKey="id"
              pagination={false}
              loading={isLoading}
              dataSource={selectedOrders}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当天无订单" /> }}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  width: 130,
                  render: (v: string) => <span className="num text-[11px] text-muted">{formatTime(v)}</span>,
                },
                {
                  title: '方向',
                  dataIndex: 'side',
                  width: 70,
                  render: (v: 'BUY' | 'SELL') => <SideTag side={v} />,
                },
                {
                  title: '数量',
                  dataIndex: 'quantity',
                  align: 'right',
                  render: (v: number) => <span className="num">{formatQty(v)}</span>,
                },
                {
                  title: '成交价',
                  dataIndex: 'filledPrice',
                  align: 'right',
                  render: (v: number) => (
                    <span className="num text-subtle">{v > 0 ? formatPrice(v) : '--'}</span>
                  ),
                },
                {
                  title: '金额',
                  dataIndex: 'quoteAmount',
                  align: 'right',
                  render: (v: number) => <span className="num">{formatUsd(v)}</span>,
                },
                {
                  title: '来源',
                  dataIndex: 'source',
                  width: 60,
                  render: (v: string) =>
                    v === 'agent' ? (
                      <Tag color="cyan" className="!text-[10px]">Agent</Tag>
                    ) : (
                      <Tag className="!text-[10px]">手动</Tag>
                    ),
                },
                {
                  title: '模式',
                  dataIndex: 'mode',
                  width: 80,
                  render: (v: OrderDTO['mode']) => <ModeTag mode={v} />,
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 90,
                  render: (v: OrderStatus) => <OrderStatusTag status={v} />,
                },
              ]}
            />
          </div>
        </Card>
      </div>

      <style>{`
        .cal-nav {
          padding: 2px 10px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.1);
          background: transparent;
          color: rgba(255,255,255,0.75);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .cal-nav:hover { border-color: rgba(255,255,255,0.3); color: #fff; }
      `}</style>
    </div>
  );
}
