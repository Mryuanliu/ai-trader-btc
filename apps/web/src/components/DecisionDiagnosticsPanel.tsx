import { Card, Empty, Progress, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import { useMemo, useState } from 'react';
import {
  useDecisionDiagnostics,
  type NearMiss,
  type SignalContribution,
  type SignalVoteStat,
} from '@/api/hooks';
import { formatTime } from '@/utils/format';

/** 阻塞原因码中文说明（对应 shared 的 BlockingReasonCode） */
const BLOCKING_REASON_LABELS: Record<string, { label: string; color: string; hint: string }> = {
  NO_CANDLES: { label: 'K 线不足', color: 'red', hint: 'K 线为空或不足指标预热期' },
  INDICATOR_NAN: { label: '指标缺失', color: 'red', hint: '关键指标为 NaN，样本不足' },
  STALE_DATA: { label: '数据过期', color: 'red', hint: '末根 K 线时间戳过旧' },
  SIGNAL_NONE: { label: '信号未达阈值', color: 'default', hint: '行情不满足规则（非错误）' },
  SIGNAL_CONFLICT: { label: '信号分歧', color: 'orange', hint: '多空票数接近' },
  BELOW_MIN_CONFIDENCE: { label: '置信度不足', color: 'orange', hint: '达阈值但被 minConfidence 拦截' },
  STRATEGY_FALLBACK: { label: '策略回退', color: 'orange', hint: '策略名不存在，已回退默认' },
  RISK_MIN_NOTIONAL: { label: '最小下单量不足', color: 'volcano', hint: '数量低于交易所最小下单单位（资金或 positionPct 太小）' },
  RISK_MAX_ORDER_AMOUNT: { label: '单笔金额超限', color: 'volcano', hint: '单笔金额超过 maxOrderAmount 上限——调高上限或降低 positionPct' },
  RISK_MAX_DAILY_ORDERS: { label: '日下单数超限', color: 'volcano', hint: '今日下单笔数已达 maxDailyOrders 上限' },
  RISK_DAILY_LOSS: { label: '日亏损止损', color: 'red', hint: '今日亏损达 dailyLossLimit，停止开仓' },
  RISK_INSUFFICIENT_BALANCE: { label: '余额不足', color: 'volcano', hint: '可用余额不足以支付该笔订单' },
  RISK_MAX_EXPOSURE: { label: '敞口超限', color: 'volcano', hint: '买入后持仓占比将超过 maxExposurePct' },
  RISK_MARGIN: { label: '保证金不足', color: 'volcano', hint: '合约可用保证金不足' },
  RISK_LIQUIDATION_DIST: { label: '强平距离不足', color: 'red', hint: '距强平价过近，拒绝加仓' },
  RISK_LEVERAGE_CLAMPED: { label: '杠杆被钳制', color: 'volcano', hint: '杠杆超过上限被钳制' },
  RISK_INTERVAL: { label: '下单间隔未到', color: 'volcano', hint: '距上一单间隔不足 minOrderIntervalSec' },
  RISK_DRAWDOWN: { label: '回撤熔断', color: 'red', hint: '回撤超过阈值，触发熔断' },
  RISK_CONFIRM_REQUIRED: { label: '缺二次确认', color: 'orange', hint: '实盘模式需要携带二次确认 Token' },
  BROKER_REJECTED: { label: '交易所拒单', color: 'red', hint: '交易所拒绝了订单' },
  ENGINE_ERROR: { label: '引擎异常', color: 'red', hint: '指标/策略运行时异常' },
};

function reasonMeta(code: string) {
  return (
    BLOCKING_REASON_LABELS[code] ?? {
      label: code,
      color: 'default',
      hint: '未识别的原因码',
    }
  );
}

/** 信号贡献条形图：一眼看出是哪个信号否决了开仓 */
function ContributionBars({ contributions }: { contributions: SignalContribution[] }) {
  if (!contributions?.length) return <span className="text-subtle">无信号归因数据</span>;
  const max = Math.max(...contributions.map((c) => c.weight), 0.01);
  return (
    <div className="flex flex-col gap-1">
      {contributions.map((c) => {
        const width = (Math.abs(c.signed) / max) * 100;
        const color =
          c.bias === 'bullish' ? 'bg-emerald-500' : c.bias === 'bearish' ? 'bg-rose-500' : 'bg-slate-600';
        return (
          <div key={c.name} className="flex items-center gap-2 text-[11px]">
            <span className="w-20 shrink-0 truncate text-subtle">{c.label}</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-white/5">
              <div className={`h-full ${color}`} style={{ width: `${width}%` }} />
            </div>
            <span
              className={`w-12 shrink-0 text-right tabular-nums ${
                c.bias === 'bullish'
                  ? 'text-emerald-400'
                  : c.bias === 'bearish'
                    ? 'text-rose-400'
                    : 'text-subtle'
              }`}
            >
              {c.bias === 'neutral' ? '弃权' : (c.signed > 0 ? '+' : '') + c.signed.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 信号投票率表：暴露「信号长期不表态」问题 */
function SignalVoteTable({ stats }: { stats: SignalVoteStat[] }) {
  if (!stats?.length) return <Empty description="暂无信号统计" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="name"
      dataSource={stats}
      columns={[
        { title: '信号', dataIndex: 'label', key: 'label' },
        {
          title: '弃权率',
          dataIndex: 'neutralRate',
          key: 'neutralRate',
          width: 160,
          sorter: (a, b) => a.neutralRate - b.neutralRate,
          defaultSortOrder: 'descend',
          render: (v: number) => (
            <Tooltip title="该信号不投票的时间占比。弃权率高 = 长期占据分母却不出力，会稀释综合分">
              <Progress
                percent={Number((v * 100).toFixed(1))}
                size="small"
                strokeColor={v > 0.5 ? '#f59e0b' : '#64748b'}
              />
            </Tooltip>
          ),
        },
        {
          title: '看多占比',
          dataIndex: 'bullishRate',
          key: 'bullishRate',
          width: 90,
          render: (v: number) => <span className="text-emerald-400">{(v * 100).toFixed(0)}%</span>,
        },
        {
          title: '看空占比',
          dataIndex: 'bearishRate',
          key: 'bearishRate',
          width: 90,
          render: (v: number) => <span className="text-rose-400">{(v * 100).toFixed(0)}%</span>,
        },
      ]}
    />
  );
}

/** 最接近触发的观望（差一点就开仓的），支持下钻 */
function NearMissTable({ items }: { items: NearMiss[] }) {
  if (!items?.length) return <Empty description="暂无观望记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="id"
      dataSource={items}
      expandable={{
        expandedRowRender: (row) => <ContributionBars contributions={row.contributions} />,
        rowExpandable: (row) => (row.contributions?.length ?? 0) > 0,
      }}
      columns={[
        {
          title: '时间',
          dataIndex: 'createdAt',
          key: 'createdAt',
          width: 150,
          render: (v: string) => formatTime(v),
        },
        {
          title: '接近度',
          dataIndex: 'proximity',
          key: 'proximity',
          width: 170,
          defaultSortOrder: 'descend',
          sorter: (a, b) => (a.proximity ?? 0) - (b.proximity ?? 0),
          render: (v: number | null) =>
            v === null ? (
              '—'
            ) : (
              <Tooltip title={`已达触发所需的 ${(v * 100).toFixed(0)}%`}>
                <Progress
                  percent={Number((v * 100).toFixed(1))}
                  size="small"
                  strokeColor={v >= 0.8 ? '#22c55e' : v >= 0.5 ? '#3b82f6' : '#64748b'}
                />
              </Tooltip>
            ),
        },
        {
          title: '当前分 / 阈值',
          key: 'score',
          width: 130,
          render: (_, row) => (
            <span className="tabular-nums">
              {row.score?.toFixed(2) ?? '—'} / {row.requiredScore?.toFixed(2) ?? '—'}
            </span>
          ),
        },
        {
          title: '阻塞原因',
          dataIndex: 'blockingReason',
          key: 'blockingReason',
          render: (v: string | null) => {
            if (!v) return '—';
            const m = reasonMeta(v);
            return (
              <Tooltip title={m.hint}>
                <Tag color={m.color}>{m.label}</Tag>
              </Tooltip>
            );
          },
        },
      ]}
    />
  );
}

/**
 * 决策诊断面板：回答「为什么没开单」。
 *
 * 排障顺序（借鉴 EasyQuant Blocking Reasons）：
 * 1. 先看 Top 原因聚合 —— 某个码长期霸榜说明是系统性问题
 * 2. 再看接近度分布 —— 是否大量堆积在「差一点」
 * 3. 最后下钻单条 —— 看具体是哪个信号拖后腿
 */
export function DecisionDiagnosticsPanel() {
  const [windowHours, setWindowHours] = useState(24);
  const { data, isLoading } = useDecisionDiagnostics(windowHours);

  const totalBlocked = useMemo(
    () => (data?.topReasons ?? []).reduce((acc, r) => acc + r.count, 0),
    [data],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-subtle">时间窗</span>
        <Segmented
          size="small"
          value={windowHours}
          onChange={(v) => setWindowHours(Number(v))}
          options={[
            { label: '24h', value: 24 },
            { label: '3 天', value: 72 },
            { label: '7 天', value: 168 },
          ]}
        />
        {data ? (
          <span className="text-[12px] text-subtle">
            共 {data.total} 条决策，其中观望 {data.holdTotal} 条
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card size="small" title="阻塞原因 Top" loading={isLoading}>
          {totalBlocked === 0 ? (
            <Empty description="暂无阻塞记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <div className="flex flex-col gap-2">
              {(data?.topReasons ?? []).map((r) => {
                const m = reasonMeta(r.code);
                return (
                  <div key={r.code} className="flex items-center gap-2">
                    <Tooltip title={m.hint}>
                      <Tag color={m.color} style={{ minWidth: 96, textAlign: 'center' }}>
                        {m.label}
                      </Tag>
                    </Tooltip>
                    <Progress
                      percent={Number((r.share * 100).toFixed(1))}
                      size="small"
                      style={{ flex: 1 }}
                    />
                    <span className="w-12 shrink-0 text-right text-[12px] tabular-nums">{r.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card size="small" title="观望的接近度分布" loading={isLoading}>
          {!data?.proximityBuckets?.length ? (
            <Empty description="暂无接近度数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <div className="flex flex-col gap-2">
              {data.proximityBuckets.map((b) => (
                <div key={b.bucket} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-[12px] text-subtle">{b.bucket}</span>
                  <Progress
                    percent={Math.min(
                      100,
                      Number(((b.count / Math.max(1, data.holdTotal)) * 100).toFixed(1)),
                    )}
                    size="small"
                    strokeColor={b.bucket.startsWith('0.8') ? '#22c55e' : '#3b82f6'}
                    style={{ flex: 1 }}
                  />
                  <span className="w-12 shrink-0 text-right text-[12px] tabular-nums">{b.count}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-subtle">
            接近度 = 已达触发所需的百分比。若大量堆积在 0.8~1.0，说明阈值略高，多数观望「差一点」就开仓。
          </div>
        </Card>
      </div>

      <Card size="small" title="最接近触发的观望（展开看信号归因）" loading={isLoading}>
        <NearMissTable items={data?.nearMisses ?? []} />
      </Card>

      <Card size="small" title="信号投票率（弃权率过高会稀释综合分）" loading={isLoading}>
        <SignalVoteTable stats={data?.signalStats ?? []} />
        <div className="mt-2 text-[11px] text-subtle">
          当前打分口径：分子只累加表态信号、分母含全部权重。因此弃权信号会稀释综合分——
          这正是「阈值 0.85 难以触及」的结构性原因，修复方案见策略增强方案 B 期。
        </div>
      </Card>
    </div>
  );
}
