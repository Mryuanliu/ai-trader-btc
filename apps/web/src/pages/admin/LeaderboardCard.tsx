import { useState } from 'react';
import { Card, Empty, Segmented, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { StrategyPerformance } from '@ai-trader/shared';
import { useLeaderboard } from '@/api/hooks';

/**
 * 净值曲线 sparkline：纯 SVG 手绘，不引入图表库。
 *
 * 排行榜里每行只有 ~96px 宽，ECharts 这种重量级方案不划算；
 * 一条折线只需要 min/max 归一化 + polyline。
 */
function Sparkline({
  points,
}: {
  points: Array<{ time: string; equity: number }>;
}) {
  if (points.length < 2) return <span className="text-subtle">--</span>;
  const w = 96;
  const h = 26;
  const pad = 2;
  const vs = points.map((p) => p.equity);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p.equity - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // 收益方向配色：终点 ≥ 起点为盈（绿），否则亏（红）
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <path
        d={d}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        style={{ stroke: up ? '#26a69a' : '#ef5350' }}
      />
    </svg>
  );
}

const PCT = (v: number | null | undefined, digits = 1) =>
  v == null ? '--' : `${(v * 100).toFixed(digits)}%`;

const WIN_LABEL: Record<'7d' | '30d' | 'all', string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

/**
 * 策略排行榜卡片。
 *
 * 排名的意义：让用户回答「该把钱交给哪个策略」——
 * 净收益看赚了多少，夏普/回撤看赚得稳不稳，胜率/盈亏比看风格。
 * 只统计已了结的篮子（服务端口径），浮盈不参与。
 */
/**
 * @param strategyName 传入则只展示该策略的绩效（策略详情页复用）；
 *                     不传则是全量排行榜（列表页视角）。
 */
export function LeaderboardCard({ strategyName }: { strategyName?: string } = {}) {
  const [win, setWin] = useState<'7d' | '30d' | 'all'>('30d');
  const { data, isLoading } = useLeaderboard(win);

  const rows = (data ?? [])
    .filter((r) => !strategyName || r.strategyName === strategyName)
    .filter((r) => r.closedBaskets > 0);
  const noDataEver = (data ?? []).length > 0 && rows.length === 0;

  const columns: ColumnsType<StrategyPerformance> = [
    {
      title: '#',
      width: 44,
      render: (_, __, idx) => (
        <span className={`num ${idx === 0 ? 'text-[15px] text-amber-400' : 'text-muted'}`}>
          {idx + 1}
        </span>
      ),
    },
    {
      title: '策略',
      render: (_, r) => (
        <div>
          <div className="text-[13px] text-white">{r.strategyName}</div>
          <div className="text-[11px] text-muted">{r.symbol}</div>
        </div>
      ),
    },
    {
      title: '净值曲线',
      width: 110,
      render: (_, r) => <Sparkline points={r.equityCurve} />,
    },
    {
      title: '净收益 (USDT)',
      align: 'right',
      sorter: (a, b) => a.totalPnl - b.totalPnl,
      render: (_, r) => (
        <span className={`num ${r.totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
          {r.totalPnl >= 0 ? '+' : ''}
          {r.totalPnl.toFixed(2)}
        </span>
      ),
    },
    {
      title: '胜率',
      align: 'right',
      render: (_, r) => <span className="num">{PCT(r.winRate)}</span>,
    },
    {
      title: '夏普',
      align: 'right',
      render: (_, r) => <span className="num">{r.sharpe.toFixed(2)}</span>,
    },
    {
      title: '盈亏比',
      align: 'right',
      render: (_, r) => (
        <span className="num">{r.profitFactor == null ? '--' : r.profitFactor.toFixed(2)}</span>
      ),
    },
    {
      title: '最大回撤',
      align: 'right',
      render: (_, r) => (
        <span className="num text-down">-{Math.abs(r.maxDrawdown).toFixed(2)}</span>
      ),
    },
    {
      title: '篮子数',
      align: 'right',
      render: (_, r) => (
        <span className="num">
          {r.closedBaskets}
          <span className="text-muted"> / {r.avgLayers.toFixed(1)} 层</span>
        </span>
      ),
    },
  ];

  return (
    <Card
      title={<span className="section-title">{strategyName ? '绩效表现' : '策略排行榜'}</span>}
      className="glass-card"
      size="small"
      extra={
        <Segmented
          size="small"
          value={win}
          onChange={(v) => setWin(v as '7d' | '30d' | 'all')}
          options={(Object.keys(WIN_LABEL) as Array<'7d' | '30d' | 'all'>).map((k) => ({
            label: WIN_LABEL[k],
            value: k,
          }))}
        />
      }
    >
      {noDataEver ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-[12px] text-muted">
              还没有已了结的篮子 —— 策略完成第一轮「建仓 → 平仓」后这里就会出现数据
            </span>
          }
        />
      ) : (
        <Table
          rowKey={(r) => `${r.strategyName}:${r.symbol}`}
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: '该窗口内没有已了结的篮子' }}
        />
      )}
    </Card>
  );
}
