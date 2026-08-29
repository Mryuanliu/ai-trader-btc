import { useState } from 'react';
import { Empty, Progress, Segmented, Skeleton, Statistic, Table, Tag, Row, Col } from 'antd';
import { useRiskEvents } from '@/api/hooks';
import { formatTime } from '@/utils/format';

const LEVEL_COLOR: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
};

export function AdminRisk() {
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState('ALL');
  const { data, isLoading } = useRiskEvents({ page, pageSize: 25 });

  const items = (data?.items ?? []).filter((i) => level === 'ALL' || i.level === level);
  const counts = (data?.items ?? []).reduce<Record<string, number>>((acc, item) => {
    acc[item.level] = (acc[item.level] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-4">
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <div className="glass-card p-5">
            <Statistic
              title={<span className="text-muted">拦截 / 提示（本页）</span>}
              value={items.length}
              valueStyle={{ color: '#F5F7FA' }}
            />
            <div className="mt-3">
              <Progress
                percent={Math.min(100, (items.length / 25) * 100)}
                showInfo={false}
                size="small"
                strokeColor="#E8A33D"
              />
            </div>
          </div>
        </Col>
        <Col xs={24} sm={8}>
          <div className="glass-card p-5">
            <Statistic
              title={<span className="text-muted">警告级事件</span>}
              value={counts.warn ?? 0}
              valueStyle={{ color: '#E8A33D' }}
            />
          </div>
        </Col>
        <Col xs={24} sm={8}>
          <div className="glass-card p-5">
            <Statistic
              title={<span className="text-muted">错误级事件</span>}
              value={counts.error ?? 0}
              valueStyle={{ color: '#F6465D' }}
            />
          </div>
        </Col>
      </Row>

      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <Segmented
          value={level}
          onChange={(v) => setLevel(String(v))}
          options={[
            { label: '全部', value: 'ALL' },
            { label: '提示', value: 'info' },
            { label: '警告', value: 'warn' },
            { label: '错误', value: 'error' },
          ]}
        />
        <span className="muted-text">共 {data?.total ?? 0} 条风控事件</span>
      </div>

      <div className="glass-card p-4">
        {isLoading && !data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            dataSource={items}
            pagination={{
              current: page,
              pageSize: 25,
              total: data?.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            locale={{ emptyText: <Empty description="暂无风控事件" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              {
                title: '时间',
                dataIndex: 'createdAt',
                width: 170,
                render: (v: string) => <span className="num text-[11px] text-muted">{formatTime(v)}</span>,
              },
              {
                title: '类型',
                dataIndex: 'type',
                width: 130,
                render: (v: string) => <span className="text-[12px] text-white/85">{v}</span>,
              },
              {
                title: '级别',
                dataIndex: 'level',
                width: 90,
                render: (v: string) => <Tag color={LEVEL_COLOR[v] ?? 'default'}>{v}</Tag>,
              },
              { title: '交易对', dataIndex: 'symbol', width: 110 },
              {
                title: '说明',
                dataIndex: 'message',
                render: (v: string) => <span className="text-[12px] text-subtle">{v}</span>,
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}
