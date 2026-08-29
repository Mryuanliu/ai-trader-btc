import { useState } from 'react';
import {
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Progress,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tag,
} from 'antd';
import { DECISION_ACTION_LABELS, type DecisionAction, type DecisionSummary } from '@ai-trader/shared';
import { useDecisionDetail, useDecisions, useLaneStats } from '@/api/hooks';
import { ActionTag } from '@/components/OrderStatusTag';
import { DecisionTimeline } from '@/components/DecisionTimeline';
import { formatRelative, formatTime } from '@/utils/format';

const ACTIONS: { label: string; value: string }[] = [
  { label: '全部', value: 'ALL' },
  { label: '买入', value: 'BUY' },
  { label: '卖出', value: 'SELL' },
  { label: '观望', value: 'HOLD' },
];

const LANES: { label: string; value: string }[] = [
  { label: '全部链路', value: 'ALL' },
  { label: '纯策略', value: 'strategy' },
  { label: '混合', value: 'hybrid' },
];

const LANE_LABELS: Record<string, string> = {
  // llm 链路已移除，仅用于存量历史记录的兼容展示
  llm: 'AI 直出（已废弃）',
  strategy: '纯策略',
  hybrid: '混合',
};

export function AdminDecisions() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('ALL');
  const [lane, setLane] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [llmOnly, setLlmOnly] = useState(false);

  const { data, isLoading } = useDecisions({
    page,
    pageSize: 20,
    action: action === 'ALL' ? undefined : action,
    lane: lane === 'ALL' ? undefined : lane,
    keyword: keyword || undefined,
  });
  const stats = useLaneStats();
  const detail = useDecisionDetail(selected);

  // 仅看真实调用了大模型的决策：便于把降级为纯指标的记录排除掉
  const rows = (data?.items ?? []).filter((item) => (llmOnly ? !item.degraded : true));

  return (
    <div className="flex flex-col gap-4">
      {stats.data && stats.data.total > 0 ? (
        <div className="glass-card flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-[12px]">
          <span className="text-subtle">
            决策总量 <span className="num text-white">{stats.data.total}</span>
          </span>
          {stats.data.lanes.map((l) => (
            <span key={l.lane} className="text-subtle">
              {LANE_LABELS[l.lane] ?? l.lane}{' '}
              <span className="num text-white">{l.count}</span>
              <span className="ml-1 text-[10px] text-muted">
                （买 {l.buys} / 卖 {l.sells} / 望 {l.holds}
                {l.degraded > 0 ? ` · 降级 ${l.degraded}` : ''}）
              </span>
            </span>
          ))}
          {stats.data.degradedTotal > 0 ? (
            <span className="text-warn">降级合计 {stats.data.degradedTotal}</span>
          ) : null}
        </div>
      ) : null}

      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <Space wrap>
          <Segmented value={lane} onChange={(v) => setLane(String(v))} options={LANES} />
          <Segmented value={action} onChange={(v) => setAction(String(v))} options={ACTIONS} />
          <Input.Search
            allowClear
            placeholder="搜索决策理由"
            style={{ width: 240 }}
            onSearch={(v) => {
              setKeyword(v);
              setPage(1);
            }}
          />
          <Checkbox checked={llmOnly} onChange={(e) => setLlmOnly(e.target.checked)}>
            <span className="text-[12px] text-subtle">仅看 LLM 决策</span>
          </Checkbox>
        </Space>
        <span className="muted-text">
          共 {data?.total ?? 0} 条决策记录
          {llmOnly ? `（本页显示 ${rows.length} 条）` : ''}
        </span>
      </div>

      <div className="glass-card p-4">
        {isLoading && !data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <Table<DecisionSummary>
            size="small"
            rowKey="id"
            dataSource={rows}
            onRow={(row) => ({ onClick: () => setSelected(row.id) })}
            className="cursor-pointer"
            pagination={{
              current: page,
              pageSize: 20,
              total: data?.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            locale={{ emptyText: <Empty description="暂无决策记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              {
                title: '时间',
                dataIndex: 'createdAt',
                width: 170,
                render: (v: string) => (
                  <div>
                    <div className="num text-[12px] text-white/90">{formatTime(v)}</div>
                    <div className="text-[10px] text-muted">{formatRelative(v)}</div>
                  </div>
                ),
              },
              { title: '交易对', dataIndex: 'symbol', width: 110 },
              {
                title: '动作',
                dataIndex: 'action',
                width: 90,
                render: (v: DecisionAction) => <ActionTag action={v} />,
              },
              {
                title: '置信度',
                dataIndex: 'confidence',
                width: 150,
                render: (v: number) => (
                  <Progress
                    percent={Math.round(v * 100)}
                    size="small"
                    strokeColor={v >= 0.6 ? '#F7931A' : '#6B7688'}
                  />
                ),
              },
              {
                title: '决策理由',
                dataIndex: 'reason',
                render: (v: string) => (
                  <span className="line-clamp-2 text-[12px] text-subtle">{v}</span>
                ),
              },
              {
                title: '链路',
                dataIndex: 'lane',
                width: 132,
                render: (_: string, row: DecisionSummary) => {
                  // 出场规则触发的决策：degradeReason 以「出场规则触发」开头（见引擎 checkExitRules）
                  if (row.degradeReason?.startsWith('出场规则触发')) {
                    return <Tag color="volcano">出场</Tag>;
                  }
                  if (row.lane === 'strategy') return <Tag color="green">策略</Tag>;
                  if (row.degraded) {
                    return row.strategyName ? (
                      <Tag color="orange">降级策略</Tag>
                    ) : (
                      <Tag color="orange">失败观望</Tag>
                    );
                  }
                  return <Tag color="geekblue">{row.llmModel ?? 'AI'}</Tag>;
                },
              },
              {
                title: '执行结果',
                dataIndex: 'riskPassed',
                width: 150,
                render: (passed: boolean, row) => {
                  if (!passed) return <Tag color="red">{row.riskRejectedBy}</Tag>;
                  if (row.action === 'HOLD') return <Tag>观望未下单</Tag>;
                  if (row.riskRejectedBy) return <Tag color="orange">{row.riskRejectedBy}</Tag>;
                  return <Tag color="green">已下单</Tag>;
                },
              },
              {
                title: '耗时',
                dataIndex: 'latencyMs',
                width: 90,
                align: 'right',
                render: (v: number) => <span className="num text-[11px] text-muted">{v} ms</span>,
              },
            ]}
          />
        )}
      </div>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        width={720}
        title={
          <div className="flex items-center gap-2">
            <span>决策链条详情</span>
            {detail.data ? <ActionTag action={detail.data.action} /> : null}
            {detail.data?.degradeReason?.startsWith('出场规则触发') ? (
              <Tag color="volcano">出场规则</Tag>
            ) : null}
            {detail.data?.lane === 'strategy' ? (
              <Tag color="green">策略{detail.data.strategyName ? ` · ${detail.data.strategyName}` : ''}</Tag>
            ) : null}
            {/* 降级标记（AI 上下文回落默认参数 / 出场规则等） */}
            {detail.data?.degraded && !detail.data.degradeReason?.startsWith('出场规则触发') ? (
              <Tag color="orange">降级{detail.data.strategyName ? ` · ${detail.data.strategyName}` : ''}</Tag>
            ) : null}
            {detail.data && !detail.data.degraded && detail.data.llmModel ? (
              <Tag color="geekblue">{detail.data.llmModel}</Tag>
            ) : null}
          </div>
        }
        destroyOnClose
      >
        {detail.isLoading ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : detail.data ? (
          <>
            <div className="mb-4 rounded-xl border border-white/[0.07] bg-black/25 p-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
                <span className="text-subtle">
                  动作 <span className="text-white">{DECISION_ACTION_LABELS[detail.data.action]}</span>
                </span>
                <span className="text-subtle">
                  置信度{' '}
                  <span className="num text-btc-light">
                    {(detail.data.confidence * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="text-subtle">
                  耗时 <span className="num text-white">{detail.data.latencyMs} ms</span>
                </span>
                <span className="text-subtle">
                  模型{' '}
                  <span className="text-white">
                    {detail.data.llmModel ?? (detail.data.degraded ? '未调用' : '--')}
                  </span>
                </span>
                {detail.data.llmUsage ? (
                  <span className="text-subtle">
                    Tokens{' '}
                    <span className="num text-white">
                      {detail.data.llmUsage.total}
                      <span className="ml-1 text-[10px] text-muted">
                        （提示 {detail.data.llmUsage.prompt} / 补全{' '}
                        {detail.data.llmUsage.completion}）
                      </span>
                    </span>
                  </span>
                ) : null}
                <span className="text-subtle">
                  时间 <span className="num text-white">{formatTime(detail.data.createdAt)}</span>
                </span>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-white/85">{detail.data.reason}</p>
              {detail.data.riskNotes ? (
                <p className="mt-2 text-[11px] leading-relaxed text-warn">
                  风险提示：{detail.data.riskNotes}
                </p>
              ) : null}
            </div>
            <DecisionTimeline record={detail.data} />
          </>
        ) : (
          <Empty description="未找到决策记录" />
        )}
        <div className="mt-6 flex justify-end">
          <Button onClick={() => setSelected(null)}>关闭</Button>
        </div>
      </Drawer>
    </div>
  );
}
