import { useState } from 'react';
import { Segmented, Table, Skeleton, Progress, Tag } from 'antd';
import clsx from 'clsx';
import { Activity, Flame, Gauge, Wallet } from 'lucide-react';
import {
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  type OrderStatus,
  type Timeframe,
} from '@ai-trader/shared';
import { useCandles, useMarketPulse, useOverview } from '@/api/hooks';
import { KlineChart } from '@/components/KlineChart';
import { StatCard } from '@/components/StatCard';
import { OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { ActionTag } from '@/components/OrderStatusTag';
import { KeywordBars } from '@/components/Sparkline';
import { EnvBadge, LivePulse } from '@/components/StatusBits';
import {
  formatPct,
  formatPrice,
  formatQty,
  formatSignedUsd,
  formatTime,
  formatUsd,
} from '@/utils/format';

export function AdminOverview() {
  const { data, isLoading } = useOverview();
  const [interval, setInterval] = useState<Timeframe>('5m');
  const { data: candles = [] } = useCandles('BTCUSDT', interval, 300);
  const { data: pulse } = useMarketPulse('BTCUSDT');

  if (isLoading && !data) {
    return <Skeleton active paragraph={{ rows: 10 }} />;
  }

  const totals = data?.totals;
  const pnl = totals?.pnlToday ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部指标条 */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="BTC / USDT"
          value={`${formatPrice(data?.ticker.price ?? 0)}`}
          tone="btc"
          icon={<Activity size={15} />}
          hint={
            <span className={(data?.ticker?.changePercent24h ?? 0) >= 0 ? 'text-up' : 'text-down'}>
              24h {formatPct(data?.ticker?.changePercent24h ?? 0)} · 高{' '}
              {formatPrice(data?.ticker?.high24h ?? 0)} / 低 {formatPrice(data?.ticker?.low24h ?? 0)}
            </span>
          }
        />
        <StatCard
          label="账户总估值"
          value={`${formatUsd(totals?.usdtValue ?? 0)} USDT`}
          icon={<Wallet size={15} />}
          hint={`持仓 ${formatQty(totals?.btcAmount ?? 0)} BTC · 未平 ${totals?.openOrders ?? 0} 单`}
        />
        <StatCard
          label="今日盈亏"
          value={
            <span className={pnl >= 0 ? 'text-up' : 'text-down'}>
              {formatSignedUsd(pnl)} USDT
            </span>
          }
          tone={pnl >= 0 ? 'up' : 'down'}
          icon={<Gauge size={15} />}
          hint={`今日已成交 ${totals?.filledToday ?? 0} 笔 · ${formatPct(totals?.pnlTodayPct ?? 0)}`}
        />
        <StatCard
          label="市场情绪"
          value={
            pulse
              ? pulse.sentiment === 'bullish'
                ? '偏强'
                : pulse.sentiment === 'bearish'
                  ? '偏弱'
                  : '震荡'
              : '--'
          }
          tone={pulse?.sentiment === 'bullish' ? 'up' : pulse?.sentiment === 'bearish' ? 'down' : 'default'}
          icon={<Flame size={15} />}
          hint={pulse ? `情绪分值 ${pulse.sentimentScore.toFixed(0)} · 量能 ${pulse.volumeRatio.toFixed(2)}x` : ''}
        />
      </section>

      {/* K 线 + 市场动向 */}
      <section className="grid gap-4 xl:grid-cols-3">
        <div className="glass-card p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className="section-title">BTC / USDT 走势</span>
              <span className="num text-[12px] text-muted">{data?.ticker.symbol}</span>
              {data ? <EnvBadge mode={data.mode} /> : null}
            </div>
            <Segmented
              size="small"
              value={interval}
              onChange={(v) => setInterval(v as Timeframe)}
              options={TIMEFRAMES.map((tf) => ({ label: TIMEFRAME_LABELS[tf], value: tf }))}
            />
          </div>
          <KlineChart candles={candles} height={340} resetKey={interval} />
        </div>

        <div className="glass-card p-4">
          <span className="section-title">今日市场动向</span>
          {pulse ? (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-subtle">{pulse.summary}</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat label="24h 涨跌" value={formatPct(pulse.changePercent24h)} up={pulse.changePercent24h >= 0} />
                <MiniStat label="量能对比" value={`${pulse.volumeRatio.toFixed(2)}x`} up={pulse.volumeRatio >= 1} />
                <MiniStat label="24h 波动率" value={`${pulse.volatility24h.toFixed(2)}%`} up={false} />
                <MiniStat label="24h 振幅" value={`${(((pulse.high24h - pulse.low24h) / Math.max(pulse.low24h, 1)) * 100).toFixed(2)}%`} up={false} />
              </div>
              <div className="divider-x my-4" />
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-subtle">
                <span>情绪强度</span>
                <span className="num">{((pulse.sentimentScore + 100) / 2).toFixed(0)} / 100</span>
              </div>
              <Progress
                percent={Math.abs((pulse.sentimentScore + 100) / 2)}
                showInfo={false}
                strokeColor={pulse.sentimentScore >= 0 ? '#0ECB81' : '#F6465D'}
                size="small"
              />
              <div className="mt-4">
                <span className="muted-text">关键词热度</span>
                <div className="mt-2">
                  <KeywordBars items={data?.keywordTrends?.slice(0, 6) ?? []} />
                </div>
              </div>
            </>
          ) : (
            <Skeleton active paragraph={{ rows: 6 }} />
          )}
        </div>
      </section>

      {/* 数据源 + 余额 */}
      <section className="grid gap-4 lg:grid-cols-3">
        <div className="glass-card p-4">
          <span className="section-title">数据源状态</span>
          <div className="mt-3 flex flex-col gap-2.5">
            {data?.dataSources?.map((source) => (
              <div key={source.name} className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 rounded-full',
                      source.ok ? 'bg-up animate-pulse-dot' : 'bg-warn',
                    )}
                  />
                  <span className="text-[12px] text-white/85">{source.label}</span>
                </div>
                <span className="max-w-[58%] text-right text-[11px] text-muted">{source.message}</span>
              </div>
            ))}
          </div>
          <div className="divider-x my-4" />
          <div className="flex flex-wrap gap-2">
            <LivePulse ok={Boolean(data?.llmAvailable)} text={data?.llmAvailable ? '模型在线' : '模型降级'} />
            <LivePulse ok={Boolean(data?.agentEnabled)} text={data?.agentEnabled ? 'Agent 运行中' : 'Agent 已停止'} />
          </div>
        </div>

        <div className="glass-card p-4 lg:col-span-2">
          <span className="section-title">账户余额</span>
          <Table
            className="mt-3"
            size="small"
            rowKey={(row) => `${row.exchange}-${row.asset}`}
            pagination={false}
            dataSource={data?.balances ?? []}
            columns={[
              { title: '资产', dataIndex: 'asset', render: (v: string) => <span className="text-white">{v}</span> },
              {
                title: '可用',
                dataIndex: 'free',
                align: 'right',
                render: (v: number) => <span className="num">{formatUsd(v, 6)}</span>,
              },
              {
                title: '冻结',
                dataIndex: 'locked',
                align: 'right',
                render: (v: number) => <span className="num text-subtle">{formatUsd(v, 6)}</span>,
              },
              {
                title: '合计',
                dataIndex: 'total',
                align: 'right',
                render: (v: number) => <span className="num text-white">{formatUsd(v, 6)}</span>,
              },
              {
                title: 'USDT 估值',
                dataIndex: 'usdtValue',
                align: 'right',
                render: (v: number) => <span className="num text-btc-light">{formatUsd(v)}</span>,
              },
            ]}
          />
        </div>
      </section>

      {/* 订单 + 决策 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="glass-card p-4">
          <span className="section-title">近期订单</span>
          <Table
            className="mt-3"
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={data?.recentOrders ?? []}
            columns={[
              {
                title: '方向',
                dataIndex: 'side',
                render: (v: 'BUY' | 'SELL') => <SideTag side={v} />,
              },
              {
                title: '价格',
                dataIndex: 'price',
                align: 'right',
                render: (v: number) => <span className="num">{formatPrice(v)}</span>,
              },
              {
                title: '数量',
                dataIndex: 'quantity',
                align: 'right',
                render: (v: number) => <span className="num">{formatQty(v)}</span>,
              },
              {
                title: '状态',
                dataIndex: 'status',
                align: 'right',
                render: (v: OrderStatus) => <OrderStatusTag status={v} />,
              },
              {
                title: '时间',
                dataIndex: 'createdAt',
                align: 'right',
                render: (v: string) => <span className="num text-[11px] text-muted">{formatTime(v)}</span>,
              },
            ]}
          />
        </div>

        <div className="glass-card p-4">
          <span className="section-title">最近决策流</span>
          <div className="mt-3 flex flex-col gap-2.5">
            {(data?.recentDecisions ?? []).map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5"
              >
                <ActionTag action={item.action} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="num text-[11px] text-btc-light">
                      {(item.confidence * 100).toFixed(0)}%
                    </span>
                    {item.degraded ? <Tag color="orange">降级</Tag> : null}
                    {!item.riskPassed ? <Tag color="red">风控拦截</Tag> : null}
                    <span className="ml-auto text-[10px] text-muted">{formatTime(item.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-subtle">
                    {item.reason}
                  </p>
                </div>
              </div>
            ))}
            {(data?.recentDecisions ?? []).length === 0 ? (
              <div className="py-8 text-center text-[12px] text-muted">暂无决策记录</div>
            ) : null}
          </div>
        </div>
      </section>

      {/* 新闻 */}
      <section className="glass-card p-4">
        <span className="section-title">最新资讯</span>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(data?.news ?? []).map((item) => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="flex flex-col rounded-xl border border-white/[0.06] bg-black/20 p-3 transition-all hover:border-btc/35 hover:shadow-glow"
            >
              <div className="flex items-center justify-between text-[10px] text-muted">
                <span className="text-btc-light">{item.source}</span>
                <span>{formatTime(item.publishedAt)}</span>
              </div>
              <div className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-white/90">
                {item.title}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {item.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-subtle">
                    {tag}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function MiniStat({ label, value, up }: { label: string; value: string; up: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
      <div className="muted-text">{label}</div>
      <div className={clsx('num mt-1 text-[16px] font-semibold', up ? 'text-up' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}
