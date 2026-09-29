import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  TIMEFRAMES,
  type BacktestMetrics,
  type BacktestReport,
  type BacktestRunSummary,
  type EquityPoint,
  type ResearchResult,
  type SweepResult,
  type Timeframe,
} from '@ai-trader/shared';
import {
  useBacktestResearch,
  useBacktestRun,
  useBacktestRuns,
  useBacktestSweep,
  useDeleteBacktestRun,
  useRunBacktest,
  useStrategies,
  type BacktestRunInput,
} from '@/api/hooks';
import { StatCard } from '@/components/StatCard';
import { formatPct, formatSignedUsd, formatTime, formatUsd } from '@/utils/format';

const { RangePicker } = DatePicker;

const TIMEFRAME_OPTIONS = TIMEFRAMES.map((t) => ({ value: t, label: t }));

/** 把表单值拼成后端入参 */
interface FormValues {
  strategyName: string;
  symbol: string;
  interval: Timeframe;
  range?: [Dayjs, Dayjs];
  initialCapital: number;
  warmupBars: number;
  feeRateBps: number;
  slippageBps: number;
  fundingPctPer8h: number;
  label?: string;
  params?: string;
  paramGrid?: string;
}

function parseJsonField(raw: string | undefined, field: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${field} 不是合法 JSON`);
  }
}

// ------------------------------------------------------------------ 净值曲线

function EquityChart({ data, height = 240 }: { data: EquityPoint[]; height?: number }) {
  if (data.length === 0) return <Empty description="无净值数据" />;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ECB81" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#0ECB81" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => dayjs(t).format('MM-DD')}
            stroke="#8b96a5"
            fontSize={11}
          />
          <YAxis
            domain={['auto', 'auto']}
            tickFormatter={(v) => formatUsd(v, 0)}
            stroke="#8b96a5"
            fontSize={11}
            width={56}
          />
          <RTooltip
            contentStyle={{ background: '#0b1220', border: '1px solid rgba(255,255,255,0.1)' }}
            labelFormatter={(t) => dayjs(t).format('YYYY-MM-DD HH:mm')}
            formatter={(v: number) => [formatUsd(v), '净值']}
          />
          <Area type="monotone" dataKey="equity" stroke="#0ECB81" strokeWidth={1.8} fill="url(#eq)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ------------------------------------------------------------------ KPI + 诚实性提示

function MetricsGrid({ m, initial }: { m: BacktestMetrics; initial: number }) {
  const beat = m.excessVsBuyHoldPct >= 0;
  return (
    <Row gutter={[12, 12]}>
      <Col xs={12} md={6}>
        <StatCard label="费后总收益" value={formatPct(m.totalReturnPct)} tone={m.totalReturnPct >= 0 ? 'up' : 'down'} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="年化收益" value={formatPct(m.annualizedReturnPct)} tone={m.annualizedReturnPct >= 0 ? 'up' : 'down'} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="最大回撤" value={formatPct(-m.maxDrawdownPct)} tone="warn" />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="夏普（篮子口径）" value={m.sharpeRatio.toFixed(2)} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="胜率" value={formatPct(m.winRate * 100, 1)} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="盈亏比" value={m.profitFactor === null ? '∞' : m.profitFactor.toFixed(2)} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard label="开仓笔数" value={m.tradeCount} />
      </Col>
      <Col xs={12} md={6}>
        <StatCard
          label="超额 vs 买入持有"
          value={formatPct(m.excessVsBuyHoldPct)}
          tone={beat ? 'up' : 'down'}
          hint={`买入持有 ${formatPct(m.buyHoldReturnPct)}｜本金 ${formatUsd(initial)}`}
        />
      </Col>
    </Row>
  );
}

function HonestyNote({ report }: { report: BacktestReport }) {
  const m = report.metrics;
  const beat = m.excessVsBuyHoldPct >= 0;
  return (
    <Alert
      showIcon
      type={beat ? 'success' : 'error'}
      message={beat ? '跑赢买入持有' : '跑输买入持有'}
      description={
        <div className="text-[12px] leading-relaxed">
          费后收益 <b>{formatPct(m.totalReturnPct)}</b>，买入持有 {formatPct(m.buyHoldReturnPct)}，超额{' '}
          <b className={beat ? 'text-up' : 'text-down'}>{formatPct(m.excessVsBuyHoldPct)}</b>。
          成本：手续费 {formatSignedUsd(report.costBreakdown.totalFees)}U、滑点{' '}
          {formatSignedUsd(report.costBreakdown.totalSlippage)}U、资金费 {formatSignedUsd(report.costBreakdown.totalFunding)}U
          （taker {report.meta.feeRateBps}bps / 滑点 {report.meta.slippageBps}bps / 成交约定 {report.meta.fillConvention}）。
        </div>
      }
    />
  );
}

function TradesTable({ report }: { report: BacktestReport }) {
  return (
    <Table
      size="small"
      rowKey={(r) => `${r.time}-${r.kind}-${r.price}-${Math.random()}`}
      dataSource={report.trades}
      pagination={{ pageSize: 10, showSizeChanger: false }}
      columns={[
        { title: '时间', dataIndex: 'time', render: (t: number) => formatTime(t) },
        { title: '动作', dataIndex: 'kind', render: (k: string) => <Tag color={k === 'OPEN' ? 'blue' : 'default'}>{k}</Tag> },
        { title: '方向', dataIndex: 'direction' },
        { title: '价格', dataIndex: 'price', render: (p: number) => formatUsd(p) },
        { title: '数量', dataIndex: 'quantity', render: (q: number) => q.toFixed(5) },
        { title: '手续费', dataIndex: 'fee', render: (f: number) => formatUsd(f) },
        { title: '净值', dataIndex: 'equityAfter', render: (e: number) => formatUsd(e) },
        { title: '原因', dataIndex: 'reason', ellipsis: true },
      ]}
    />
  );
}

// ------------------------------------------------------------------ 稳健性面板

/** 双模式对照面板：TRUE/FALSE 两组关键指标并排，附验收硬判据提示 */
function ComparePanel({
  keyName,
  on,
  off,
  ddReducePct,
  oosSharpeGain,
}: {
  keyName: string;
  on: ResearchResult;
  off: ResearchResult;
  ddReducePct: number;
  oosSharpeGain: number;
}) {
  const ddOk = Number.isFinite(ddReducePct) && ddReducePct >= 30;
  const shOk = oosSharpeGain >= 3;
  const dsrOk = on.deflatedSharpe.passed || off.deflatedSharpe.passed;
  return (
    <div className="mt-3 space-y-3">
      <Alert
        showIcon
        type={ddOk && shOk && dsrOk ? 'success' : 'warning'}
        message={`翻转开关：${keyName}`}
        description={
          <span className="text-[12px]">
            验收硬判据（plan §F）：回撤降幅 ≥ 30% → {ddOk ? '✔' : '✘'}（当前 {Number.isFinite(ddReducePct) ? ddReducePct.toFixed(2) : 'NaN'}%）
            ‧ OOS Sharpe 抬升 ≥ 3 → {shOk ? '✔' : '✘'}（当前 {oosSharpeGain.toFixed(2)}）
            ‧ 至少一份 DSR 通过 → {dsrOk ? '✔' : '✘'}
          </span>
        }
      />
      <Table
        size="small"
        pagination={false}
        rowKey="k"
        dataSource={[
          { k: 'OOS 拼接 Sharpe', on: on.walkForward.aggregateOosSharpe.toFixed(2), off: off.walkForward.aggregateOosSharpe.toFixed(2) },
          { k: 'IS 均 Sharpe', on: on.walkForward.aggregateIsSharpe.toFixed(2), off: off.walkForward.aggregateIsSharpe.toFixed(2) },
          { k: 'OOS 回撤 (%)', on: on.walkForward.oosMaxDrawdownPct.toFixed(2), off: off.walkForward.oosMaxDrawdownPct.toFixed(2) },
          { k: 'OOS 费后收益 (%)', on: on.walkForward.oosTotalReturnPct.toFixed(2), off: off.walkForward.oosTotalReturnPct.toFixed(2) },
          { k: 'OOS 笔数', on: String(on.walkForward.oosTradeCount), off: String(off.walkForward.oosTradeCount) },
          { k: 'DSR', on: `${on.deflatedSharpe.dsr.toFixed(3)} (${on.deflatedSharpe.passed ? 'pass' : 'overfit'})`, off: `${off.deflatedSharpe.dsr.toFixed(3)} (${off.deflatedSharpe.passed ? 'pass' : 'overfit'})` },
        ]}
        columns={[
          { title: '指标', dataIndex: 'k' },
          { title: `${keyName} = TRUE`, dataIndex: 'on', render: (v: string) => <b className="text-up">{v}</b> },
          { title: `${keyName} = FALSE`, dataIndex: 'off', render: (v: string) => <span className="muted-text">{v}</span> },
        ]}
      />
    </div>
  );
}

function ResearchPanel({ r }: { r: ResearchResult }) {
  const wf = r.walkForward;
  const overfit = r.verdict === 'overfit';
  return (
    <div className="space-y-4">
      <Alert
        showIcon
        type={overfit ? 'error' : 'success'}
        message={overfit ? '判定过拟合 · 不建议上架' : '通过 DSR 闸门 · 可作上架候选'}
        description={<span className="text-[12px]">{r.note}</span>}
      />
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <StatCard label="全样本 IS 夏普" value={wf.aggregateIsSharpe.toFixed(2)} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard
            label="样本外 OOS 夏普（权威）"
            value={wf.aggregateOosSharpe.toFixed(2)}
            tone={wf.aggregateOosSharpe < wf.aggregateIsSharpe ? 'down' : 'up'}
            hint={`落差 ${(wf.aggregateIsSharpe - wf.aggregateOosSharpe).toFixed(2)}`}
          />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label="Deflated Sharpe" value={r.deflatedSharpe.dsr.toFixed(3)} tone={overfit ? 'down' : 'up'} hint={`阈值内试验数 ${r.deflatedSharpe.nTrials}`} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label="OOS 收益 / 回撤" value={formatPct(wf.oosTotalReturnPct)} hint={`最大回撤 ${formatPct(-wf.oosMaxDrawdownPct)}`} />
        </Col>
      </Row>

      <Card size="small" title="样本外拼接净值" className="!border-white/[0.06] !bg-white/[0.02]">
        <EquityChart data={wf.oosEquity} />
      </Card>

      <Table
        size="small"
        rowKey="index"
        dataSource={wf.segments}
        pagination={{ pageSize: 8, showSizeChanger: false }}
        columns={[
          { title: '#', dataIndex: 'index' },
          { title: '训练→测试', render: (_, s) => `${formatTime(s.trainFrom)} → ${formatTime(s.testTo)}` },
          { title: 'IS 夏普', dataIndex: 'isSharpe', render: (v: number) => v.toFixed(2) },
          { title: 'OOS 夏普', dataIndex: 'oosSharpe', render: (v: number) => <b className={v < 0 ? 'text-down' : 'text-up'}>{v.toFixed(2)}</b> },
          { title: 'OOS 收益', dataIndex: 'oosTotalReturnPct', render: (v: number) => formatPct(v) },
          { title: 'OOS 笔数', dataIndex: 'oosTradeCount' },
        ]}
      />

      {r.cpcv ? (
        <Card size="small" title="CPCV OOS 夏普分布" className="!border-white/[0.06] !bg-white/[0.02]">
          <div className="flex flex-wrap gap-4 text-[12px] text-subtle">
            <span>组合数 <b className="text-white">{r.cpcv.nCombos}</b></span>
            <span>均值 <b className="text-white">{r.cpcv.mean.toFixed(2)}</b></span>
            <span>标准差 <b className="text-white">{r.cpcv.std.toFixed(2)}</b></span>
            <span>最差 <b className="text-down">{r.cpcv.min.toFixed(2)}</b></span>
            <span>分位(5/25/50/75/95) <b className="text-white">{r.cpcv.quantiles.map((q) => q.toFixed(1)).join(' / ')}</b></span>
          </div>
          <div style={{ height: 160 }} className="mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={r.cpcv.oosSharpes.map((s, i) => ({ i, s }))} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="i" stroke="#8b96a5" fontSize={10} />
                <YAxis stroke="#8b96a5" fontSize={10} width={40} />
                <RTooltip contentStyle={{ background: '#0b1220', border: '1px solid rgba(255,255,255,0.1)' }} />
                <ReferenceLine y={0} stroke="#F6465D" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="s" stroke="#F0B90B" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 参数扫描面板

function SweepPanel({ r }: { r: SweepResult }) {
  const dsrOf = (i: number) => r.cells[i]?.dsr?.dsr;
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-subtle">
        共 <b className="text-white">{r.combos}</b> 组参数；高亮行为 per-bar 夏普最优者。DSR 列按「试验数=组合数」校正挑选偏差，&lt; 0.95 视为多重比较的运气。
      </div>
      <Table
        size="small"
        rowKey={(_, i) => String(i)}
        dataSource={r.cells}
        pagination={{ pageSize: 12, showSizeChanger: false }}
        rowClassName={(_, i) => (i === r.bestIndex ? 'bg-btc/10' : '')}
        columns={[
          ...r.gridKeys.map((k) => ({
            title: k,
            render: (_: unknown, cell: (typeof r.cells)[number]) => String(cell.params[k]),
          })),
          { title: '费后收益', render: (_: unknown, c: (typeof r.cells)[number]) => formatPct(c.metrics.totalReturnPct) },
          { title: '夏普', render: (_: unknown, c: (typeof r.cells)[number]) => c.metrics.sharpeRatio.toFixed(2) },
          { title: '最大回撤', render: (_: unknown, c: (typeof r.cells)[number]) => formatPct(-c.metrics.maxDrawdownPct) },
          {
            title: 'DSR',
            render: (_: unknown, c: (typeof r.cells)[number], i: number) => {
              const d = dsrOf(i);
              if (d === undefined) return '--';
              return <span className={d >= 0.95 ? 'text-up' : 'text-down'}>{d.toFixed(3)}</span>;
            },
          },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------------ 历史面板

function HistoryPanel({ onPreview }: { onPreview: (id: string) => void }) {
  const runs = useBacktestRuns({ pageSize: 20 });
  const del = useDeleteBacktestRun();
  const KIND_COLOR: Record<string, string> = { single: 'blue', research: 'gold', sweep: 'purple' };
  return (
    <Table
      size="small"
      rowKey="id"
      loading={runs.isLoading}
      dataSource={runs.data?.items ?? []}
      pagination={{ pageSize: 10, showSizeChanger: false }}
      columns={[
        { title: '时间', dataIndex: 'createdAt', render: (t: string) => formatTime(t) },
        { title: '类型', dataIndex: 'kind', render: (k: string) => <Tag color={KIND_COLOR[k]}>{k}</Tag> },
        { title: '策略', dataIndex: 'strategyName' },
        { title: '标的/周期', render: (_, r: BacktestRunSummary) => `${r.symbol} ${r.interval}` },
        { title: '区间', render: (_, r: BacktestRunSummary) => `${formatTime(r.from)}→${formatTime(r.to)}` },
        { title: '费后收益', dataIndex: 'totalReturnPct', render: (v: number | null) => (v === null ? '--' : formatPct(v)) },
        { title: '夏普', dataIndex: 'sharpe', render: (v: number | null) => (v === null ? '--' : v.toFixed(2)) },
        { title: 'OOS', dataIndex: 'oosSharpe', render: (v: number | null) => (v === null ? '--' : v.toFixed(2)) },
        {
          title: 'DSR',
          dataIndex: 'dsr',
          render: (v: number | null) => (v === null ? '--' : <span className={v >= 0.95 ? 'text-up' : 'text-down'}>{v.toFixed(3)}</span>),
        },
        {
          title: '操作',
          render: (_, r: BacktestRunSummary) => (
            <Space>
              <Button size="small" type="link" onClick={() => onPreview(r.id)}>
                回看
              </Button>
              <Button size="small" type="link" danger loading={del.isPending} onClick={() => void del.mutate(r.id)}>
                删除
              </Button>
            </Space>
          ),
        },
      ]}
    />
  );
}

// ------------------------------------------------------------------ 页面

export function AdminBacktest() {
  const [params] = useSearchParams();
  const { message } = AntApp.useApp();
  const strategies = useStrategies();
  const [form] = Form.useForm<FormValues>();

  const [report, setReport] = useState<BacktestReport | null>(null);
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  // P1 双模式对照（L1 波动率定标 vs 固定仓位）：同一区间、同一 params、只翻转一个开关
  const [compareKey, setCompareKey] = useState<string>('useVolSizing');
  const [compare, setCompare] = useState<{ key: string; on: ResearchResult; off: ResearchResult; atv: number; oosGain: number } | null>(null);
  const [comparePending, setComparePending] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = useBacktestRun(previewId);

  const run = useRunBacktest();
  const researchM = useBacktestResearch();
  const sweepM = useBacktestSweep();

  const deepStrategy = params.get('strategy');
  const initialValues = useMemo<FormValues>(
    () => ({
      strategyName: deepStrategy ?? 'trend_following',
      symbol: 'BTCUSDT',
      interval: '5m',
      initialCapital: 10_000,
      warmupBars: 120,
      feeRateBps: 4,
      slippageBps: 5,
      fundingPctPer8h: 0,
    }),
    [deepStrategy],
  );

  function buildBody(): BacktestRunInput {
    const v = form.getFieldsValue();
    if (!v.strategyName) throw new Error('请选择策略');
    if (!v.range) throw new Error('请选择回测区间');
    return {
      strategyName: v.strategyName,
      symbol: v.symbol || 'BTCUSDT',
      interval: v.interval,
      from: v.range[0].valueOf(),
      to: v.range[1].valueOf(),
      initialCapital: v.initialCapital,
      warmupBars: v.warmupBars,
      feeRateBps: v.feeRateBps,
      slippageBps: v.slippageBps,
      fundingPctPer8h: v.fundingPctPer8h,
      label: v.label,
      params: v.params ? parseJsonField(v.params, '策略参数') : undefined,
    };
  }

  const doRun = () => {
    let body: BacktestRunInput;
    try {
      body = buildBody();
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    run.mutate(body, {
      onSuccess: (r) => {
        setReport(r);
        message.success(`回测完成：${r.metrics.tradeCount} 笔，费后 ${formatPct(r.metrics.totalReturnPct)}`);
      },
      onError: (e) => message.error(e.message),
    });
  };

  const doResearch = () => {
    let body: BacktestRunInput;
    try {
      body = buildBody();
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    researchM.mutate(
      { ...body, trainBars: 240, testBars: 120, cpcv: { nFoldK: 5, testFoldSize: 1 } },
      {
        onSuccess: (r) => {
          setResearch(r);
          message.success(r.verdict === 'pass' ? '通过 DSR 闸门' : '判定过拟合');
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /** 双模式对照：同一区间、同一 params，只翻转 `compareKey` 一个开关（TRUE vs FALSE） */
  const doCompare = async () => {
    let body: BacktestRunInput;
    const key = compareKey.trim();
    if (!key) {
      message.error('请填写要翻转的参数名（如 useVolSizing）');
      return;
    }
    try {
      body = buildBody();
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    const base = (body.params ?? {}) as Record<string, unknown>;
    const scheme = { trainBars: 240, testBars: 120, cpcv: { nFoldK: 5, testFoldSize: 1 } };
    setComparePending(true);
    try {
      const [on, off] = await Promise.all([
        researchM.mutateAsync({ ...body, ...scheme, params: { ...base, [key]: true } }),
        researchM.mutateAsync({ ...body, ...scheme, params: { ...base, [key]: false } }),
      ]);
      const ddOff = off.walkForward.oosMaxDrawdownPct;
      const ddOn = on.walkForward.oosMaxDrawdownPct;
      const atv = ddOff > 0 ? ((ddOff - ddOn) / ddOff) * 100 : Number.NaN;
      const oosGain = on.walkForward.aggregateOosSharpe - off.walkForward.aggregateOosSharpe;
      setCompare({ key, on, off, atv, oosGain });
      message.success('双模式对照完成');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setComparePending(false);
    }
  };

  const doSweep = () => {
    let body: BacktestRunInput;
    let grid: Record<string, number[]>;
    try {
      body = buildBody();
      grid = parseJsonField(form.getFieldValue('paramGrid'), '参数网格') as unknown as Record<string, number[]>;
      if (!grid || Object.keys(grid).length === 0) throw new Error('请填写参数网格 JSON，如 {"atrPeriod":[10,14,20]}');
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    sweepM.mutate(
      { ...body, paramGrid: grid },
      {
        onSuccess: (r) => {
          setSweep(r);
          message.success(`扫描完成：${r.combos} 组`);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const anyPending = run.isPending || researchM.isPending || sweepM.isPending;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[17px] font-semibold text-white">回测台</h2>
        <div className="muted-text mt-0.5">
          用历史 K 线回放**同一份策略代码**（与实盘 parity），强制次根开盘成交、双边费用与滑点，并以 walk-forward + Deflated Sharpe 拦过拟合。
        </div>
      </div>

      {/* 配置表单 */}
      <Card size="small" className="!border-white/[0.06] !bg-white/[0.02]">
        <Form form={form} layout="vertical" initialValues={initialValues}>
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <Form.Item label="策略" name="strategyName">
                <Select
                  placeholder="选择策略"
                  options={(strategies.data ?? []).map((s) => ({ value: s.name, label: s.label }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="标的" name="symbol">
                <Input placeholder="BTCUSDT" />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="周期" name="interval">
                <Select options={TIMEFRAME_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item label="回测区间" name="range">
                <RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={12} md={4}>
              <Form.Item label="初始本金" name="initialCapital">
                <InputNumber min={1} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="预热根数" name="warmupBars">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="手续费(bps)" name="feeRateBps">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="滑点(bps)" name="slippageBps">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="资金费(每8h)" name="fundingPctPer8h">
                <InputNumber step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="备注" name="label">
                <Input placeholder="可选" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item label="策略参数(JSON)" name="params" extra='如 {"atrPeriod":14,"stopAtrMult":2}'>
                <Input.TextArea rows={2} placeholder="留空用默认参数" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="参数网格(JSON,仅扫描)" name="paramGrid" extra='如 {"atrPeriod":[10,14,20],"stopAtrMult":[1.5,2,2.5]}'>
                <Input.TextArea rows={2} placeholder="参数扫描用" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Tabs
        defaultActiveKey="single"
        items={[
          {
            key: 'single',
            label: '单次回测',
            children: (
              <div className="space-y-4">
                <Space>
                  <Button type="primary" loading={run.isPending} onClick={doRun}>
                    运行回测
                  </Button>
                </Space>
                {report ? (
                  <>
                    <MetricsGrid m={report.metrics} initial={report.meta.initialCapital} />
                    <HonestyNote report={report} />
                    <Card size="small" title="净值曲线" className="!border-white/[0.06] !bg-white/[0.02]">
                      <EquityChart data={report.equityCurve} />
                    </Card>
                    <Card size="small" title="逐笔成交" className="!border-white/[0.06] !bg-white/[0.02]">
                      <TradesTable report={report} />
                    </Card>
                  </>
                ) : (
                  <Empty description="设置区间后点「运行回测」" />
                )}
              </div>
            ),
          },
          {
            key: 'research',
            label: '稳健性 (walk-forward + DSR)',
            children: (
              <div className="space-y-4">
                <Button type="primary" loading={researchM.isPending} onClick={doResearch}>
                  运行稳健性研究
                </Button>
                {research ? <ResearchPanel r={research} /> : <Empty description="运行后展示 IS/OOS 落差与 DSR 闸门" />}

                <div className="mt-6 border-t border-white/[0.06] pt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-[13px] text-white">双模式对照</span>
                    <Input
                      size="small"
                      style={{ width: 180 }}
                      value={compareKey}
                      onChange={(e) => setCompareKey(e.target.value)}
                      placeholder="翻转的参数名"
                    />
                    <span className="text-[12px] muted-text">同一区间同一 params，只翻转该 boolean 开关（TRUE vs FALSE）</span>
                    <Button loading={comparePending} onClick={doCompare} disabled={!compareKey.trim()}>
                      运行对照
                    </Button>
                  </div>
                  {compare ? (
                    <ComparePanel
                      keyName={compare.key}
                      on={compare.on}
                      off={compare.off}
                      ddReducePct={compare.atv}
                      oosSharpeGain={compare.oosGain}
                    />
                  ) : (
                    <Empty
                      className="mt-3"
                      description="开启 L1 波动率定标时建议运行一次，将 TRUE/FALSE 两组的 OOS 回撤与 Sharpe 并排展示"
                    />
                  )}
                </div>
              </div>
            ),
          },
          {
            key: 'sweep',
            label: '参数扫描',
            children: (
              <div className="space-y-4">
                <Button type="primary" loading={sweepM.isPending} onClick={doSweep}>
                  运行参数扫描
                </Button>
                {sweep ? <SweepPanel r={sweep} /> : <Empty description="填参数网格 JSON 后运行" />}
              </div>
            ),
          },
          {
            key: 'history',
            label: '历史',
            children: (
              <div className="space-y-4">
                <HistoryPanel onPreview={setPreviewId} />
                {previewId && preview.data ? (
                  <Card
                    size="small"
                    title={`回看：${preview.data.strategyName} · ${preview.data.kind}`}
                    className="!border-white/[0.06] !bg-white/[0.02]"
                    extra={<Button size="small" type="link" onClick={() => setPreviewId(null)}>关闭</Button>}
                  >
                    {preview.data.kind === 'single' ? (
                      <MetricsGrid m={(preview.data.report as BacktestReport).metrics} initial={preview.data.initialCapital} />
                    ) : preview.data.kind === 'research' ? (
                      <ResearchPanel r={preview.data.report as ResearchResult} />
                    ) : (
                      <SweepPanel r={preview.data.report as SweepResult} />
                    )}
                  </Card>
                ) : null}
              </div>
            ),
          },
        ]}
      />

      {anyPending ? <Spin className="!fixed !bottom-6 !right-6" /> : null}
    </div>
  );
}
