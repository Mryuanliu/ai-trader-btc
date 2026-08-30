import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  InputNumber,
  Progress,
  Row,
  Select,
  Skeleton,
  Slider,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@ai-trader/shared';
import {
  useBacktestProgress,
  useBacktestStrategies,
  useRunBacktest,
  type BacktestReportDTO,
} from '@/api/hooks';
import { formatTime } from '@/utils/format';

/** 参数 schema 的 properties 项（策略内置的简化 JSON Schema） */
interface ParamProp {
  type?: string;
  minimum?: number;
  maximum?: number;
  title?: string;
}

const { RangePicker } = DatePicker;

interface FormValues {
  range: [Dayjs, Dayjs];
  symbol: string;
  interval: Timeframe;
  strategyName: string;
  strategyParams?: Record<string, number | null>;
  exitRules?: { stopLossPct?: number | null; takeProfitPct?: number | null };
  initialCapital?: number;
  positionPct?: number;
  minConfidence?: number;
  slippageBps?: number;
  feeRateBps?: number;
  warmupBars?: number;
  autoBackfill?: boolean;
  market?: 'spot' | 'futures';
  leverage?: number;
  compareLeverage?: boolean;
}

export function AdminBacktest() {
  const [form] = Form.useForm<FormValues>();
  const strategies = useBacktestStrategies();
  const runBacktest = useRunBacktest();
  const progress = useBacktestProgress(runBacktest.isPending);
  const [report, setReport] = useState<BacktestReportDTO | null>(null);

  const strategyName = Form.useWatch('strategyName', form);
  const current = useMemo(
    () => strategies.data?.find((s) => s.name === strategyName) ?? strategies.data?.[0],
    [strategies.data, strategyName],
  );
  const paramProps = (current?.paramSchema?.properties ?? {}) as Record<string, ParamProp>;

  const onFinish = (values: FormValues) => {
    // 未填写的动态参数不提交，交给策略 normalizeParams 用默认值
    const strategyParams: Record<string, number> = {};
    for (const [key, value] of Object.entries(values.strategyParams ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) strategyParams[key] = value;
    }
    const exitRules = {
      stopLossPct: values.exitRules?.stopLossPct ?? null,
      takeProfitPct: values.exitRules?.takeProfitPct ?? null,
    };
    runBacktest.mutate(
      {
        symbol: values.symbol || 'BTCUSDT',
        interval: values.interval || '5m',
        from: values.range[0].startOf('day').toISOString(),
        to: values.range[1].endOf('day').toISOString(),
        initialCapital: values.initialCapital,
        positionPct: values.positionPct,
        minConfidence: values.minConfidence,
        slippageBps: values.slippageBps,
        feeRateBps: values.feeRateBps,
        warmupBars: values.warmupBars,
        autoBackfill: values.autoBackfill !== false,
        strategyName: current?.name,
        strategyParams: Object.keys(strategyParams).length ? strategyParams : undefined,
        exitRules,
        market: values.market,
        leverage: values.market === 'futures' ? values.leverage : undefined,
        compareLeverage: values.market === 'futures' ? values.compareLeverage : undefined,
      },
      {
        onSuccess: (data) => {
          setReport(data);
          message.success('回测完成');
        },
        onError: (err) => message.error(err.message),
      },
    );
  };

  const metrics = report?.metrics;
  const curve = (report?.equityCurve ?? []).map((p) => ({
    ...p,
    timeLabel: formatTime(new Date(p.time).toISOString()),
  }));

  return (
    <div className="flex flex-col gap-4">
      <Card title="回测参数" className="glass-card" size="small">
        <Form<FormValues>
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{
            range: [dayjs().subtract(30, 'day'), dayjs()],
            symbol: 'BTCUSDT',
            interval: '5m',
            strategyName: 'trend_following',
            initialCapital: 10000,
            positionPct: 0.1,
            minConfidence: 0.6,
            slippageBps: 5,
            feeRateBps: 10,
            warmupBars: 120,
            autoBackfill: true,
            market: 'spot',
            leverage: 5,
          }}
        >
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="range" label="回测区间" rules={[{ required: true }]}>
                <RangePicker showTime className="!w-full" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="market" label="市场">
                <Select
                  options={[
                    { label: '现货', value: 'spot' },
                    { label: '合约', value: 'futures' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="symbol" label="交易对">
                <Select
                  options={[{ label: 'BTC/USDT', value: 'BTCUSDT' }]}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="interval" label="K 线周期">
                <Select options={TIMEFRAMES.map((tf) => ({ label: TIMEFRAME_LABELS[tf], value: tf }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="strategyName" label="策略">
                <Select
                  options={(strategies.data ?? []).map((s) => ({
                    label: `${s.label}（${s.name}）`,
                    value: s.name,
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            {Object.entries(paramProps).map(([key, prop]) => (
              <Col span={8} key={key}>
                <Form.Item
                  name={['strategyParams', key]}
                  label={prop.title ?? key}
                  tooltip={`${prop.minimum ?? '-'} ~ ${prop.maximum ?? '-'}；留空使用默认值 ${
                    current?.defaultParams?.[key] ?? '-'
                  }`}
                >
                  <InputNumber
                    min={prop.minimum}
                    max={prop.maximum}
                    step={0.01}
                    placeholder={String(current?.defaultParams?.[key] ?? '默认')}
                    className="!w-full"
                  />
                </Form.Item>
              </Col>
            ))}
          </Row>

          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="initialCapital" label="初始资金 (USDT)">
                <InputNumber min={100} max={10_000_000} step={100} className="!w-full" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="positionPct" label="单次仓位比例">
                <Slider min={0.01} max={1} step={0.01} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="minConfidence" label="最低置信度">
                <Slider min={0} max={1} step={0.05} />
              </Form.Item>
            </Col>
          </Row>

          {form.getFieldValue('market') === 'futures' ? (
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="leverage" label="合约杠杆（倍数）">
                  <Slider min={1} max={10} step={1} marks={{ 1: '1x', 5: '5x', 10: '10x' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="compareLeverage" valuePropName="checked" label=" ">
                  <Space>
                    <Switch /> 附加 1x/3x/5x 杠杆对比
                  </Space>
                </Form.Item>
              </Col>
            </Row>
          ) : null}

          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name={['exitRules', 'stopLossPct']} label="止损（相对均价，留空关闭）">
                <InputNumber min={0.001} max={1} step={0.01} className="!w-full" placeholder="关闭" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name={['exitRules', 'takeProfitPct']} label="止盈（相对均价，留空关闭）">
                <InputNumber min={0.001} max={1} step={0.01} className="!w-full" placeholder="关闭" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="slippageBps" label="滑点 (bps)">
                <InputNumber min={0} max={100} className="!w-full" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="feeRateBps" label="手续费 (bps)">
                <InputNumber min={0} max={200} className="!w-full" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="autoBackfill" label="自动回填K线" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>

          <Button
            type="primary"
            htmlType="submit"
            icon={<PlayCircleOutlined />}
            loading={runBacktest.isPending}
          >
            {runBacktest.isPending ? '回测运行中…（含历史回填时较慢）' : '运行回测'}
          </Button>
          {current ? (
            <span className="ml-3 text-[11px] text-muted">{current.description}</span>
          ) : null}
        </Form>
      </Card>

      {runBacktest.isPending ? (
        <Card size="small" className="glass-card">
          <Progress
            percent={progress.data?.pct ?? 0}
            status="active"
            strokeColor="#F7931A"
          />
          <div className="mt-1 text-[12px] text-muted">
            {progress.data?.detail ?? '正在启动回测…'}
          </div>
        </Card>
      ) : null}

      {report && metrics ? (
        <>
          <Card
            title={`回测报告 · ${report.meta.strategyName}${report.meta.leverage ? ` · ${report.meta.leverage}x 杠杆` : ''}`}
            className="glass-card"
            size="small"
          >
            <Row gutter={[16, 12]}>
              <Col xs={8} md={4}>
                <Statistic
                  title="总收益"
                  value={metrics.totalReturnPct}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: metrics.totalReturnPct >= 0 ? '#4ade80' : '#f87171' }}
                />
              </Col>
              <Col xs={8} md={4}>
                <Statistic title="年化" value={metrics.annualizedReturnPct} precision={2} suffix="%" />
              </Col>
              <Col xs={8} md={4}>
                <Statistic
                  title="最大回撤"
                  value={metrics.maxDrawdownPct}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: '#f87171' }}
                />
              </Col>
              <Col xs={8} md={3}>
                <Statistic title="夏普" value={metrics.sharpeRatio} precision={2} />
              </Col>
              <Col xs={8} md={3}>
                <Statistic title="胜率" value={(metrics.winRate * 100)} precision={1} suffix="%" />
              </Col>
              <Col xs={8} md={3}>
                <Statistic
                  title="盈亏比"
                  value={metrics.profitFactor}
                  precision={2}
                  formatter={(v) => (v === Infinity ? '∞' : String(v))}
                />
              </Col>
              <Col xs={8} md={3}>
                <Statistic title="交易次数" value={metrics.tradeCount} />
              </Col>
              {report.meta.liquidationCount !== undefined ? (
                <Col xs={8} md={3}>
                  <Statistic
                    title="强平次数"
                    value={report.meta.liquidationCount}
                    valueStyle={{ color: report.meta.liquidationCount > 0 ? '#f87171' : '#4ade80' }}
                  />
                </Col>
              ) : null}
            </Row>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
              <span>
                Buy&amp;Hold {metrics.buyHoldReturnPct.toFixed(2)}% · 超额{' '}
                <span className={metrics.excessVsBuyHoldPct >= 0 ? 'text-up' : 'text-down'}>
                  {metrics.excessVsBuyHoldPct.toFixed(2)}%
                </span>
              </span>
              <span>
                {report.meta.candleCount} 根K线 · warmup {report.meta.warmupBars} · 信号后下一根开盘价成交
              </span>
              {report.meta.totalFundingPaid !== undefined ? (
                <span>
                  资金费 {report.meta.totalFundingPaid.toFixed(4)} USDT
                  {report.meta.totalFundingPaid > 0 ? '（净支出）' : report.meta.totalFundingPaid < 0 ? '（净收入）' : ''}
                </span>
              ) : null}
              {report.meta.exitRules.stopLossPct != null || report.meta.exitRules.takeProfitPct != null ? (
                <span>
                  出场：{report.meta.exitRules.stopLossPct != null ? `止损 ${(report.meta.exitRules.stopLossPct * 100).toFixed(1)}% ` : ''}
                  {report.meta.exitRules.takeProfitPct != null ? `止盈 ${(report.meta.exitRules.takeProfitPct * 100).toFixed(1)}%` : ''}
                </span>
              ) : null}
              {report.meta.downsampled ? <Tag>权益曲线已下采样</Tag> : null}
            </div>
          </Card>

          <Card title="权益曲线与回撤" className="glass-card" size="small">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#F7931A" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#F7931A" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f87171" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
                  <XAxis dataKey="timeLabel" tick={{ fontSize: 10, fill: '#8b93a7' }} minTickGap={48} />
                  <YAxis yAxisId="eq" tick={{ fontSize: 10, fill: '#8b93a7' }} width={70} domain={['auto', 'auto']} />
                  <YAxis yAxisId="dd" orientation="right" tick={{ fontSize: 10, fill: '#8b93a7' }} width={48} unit="%" />
                  <Tooltip
                    contentStyle={{ background: '#141821', border: '1px solid #ffffff22', fontSize: 12 }}
                    labelStyle={{ color: '#8b93a7' }}
                  />
                  <Area
                    yAxisId="eq"
                    type="monotone"
                    dataKey="equity"
                    name="权益"
                    stroke="#F7931A"
                    fill="url(#eqGrad)"
                    dot={false}
                  />
                  <Area
                    yAxisId="dd"
                    type="monotone"
                    dataKey="drawdownPct"
                    name="回撤"
                    stroke="#f87171"
                    fill="url(#ddGrad)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {report.comparison && report.comparison.length > 0 ? (
            <Card title="杠杆对比（同一策略同一数据，仅杠杆不同）" className="glass-card" size="small">
              <Table
                size="small"
                rowKey="leverage"
                pagination={false}
                dataSource={report.comparison}
                columns={[
                  { title: '杠杆', dataIndex: 'leverage', width: 80, render: (v: number) => <b>{v}x</b> },
                  { title: '总收益%', dataIndex: 'totalReturnPct', render: (v: number) => <span className={v >= 0 ? 'text-up' : 'text-down'}>{v.toFixed(2)}</span> },
                  { title: '年化%', dataIndex: 'annualizedReturnPct', render: (v: number) => v.toFixed(2) },
                  { title: '最大回撤%', dataIndex: 'maxDrawdownPct', render: (v: number) => <span className="text-down">{v.toFixed(2)}</span> },
                  { title: '夏普', dataIndex: 'sharpeRatio', render: (v: number) => v.toFixed(2) },
                  { title: '胜率%', dataIndex: 'winRate', render: (v: number) => (v * 100).toFixed(1) },
                  { title: '盈亏比', dataIndex: 'profitFactor', render: (v: number) => (v === Infinity ? '∞' : v.toFixed(2)) },
                  { title: '交易', dataIndex: 'tradeCount' },
                  { title: '强平', dataIndex: 'liquidationCount', render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : v) },
                  { title: '资金费', dataIndex: 'totalFundingPaid', render: (v: number) => v.toFixed(4) },
                ]}
              />
            </Card>
          ) : null}

          <Card title={`成交明细（${report.trades.length} 笔，最多展示最近 200 笔）`} className="glass-card" size="small">
            <Table
              size="small"
              rowKey={(r) => `${r.time}-${r.side}-${r.price}`}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              dataSource={[...report.trades].slice(-200).reverse()}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'time',
                  width: 170,
                  render: (v: number) => formatTime(new Date(v).toISOString()),
                },
                {
                  title: '方向',
                  dataIndex: 'side',
                  width: 80,
                  render: (v: 'BUY' | 'SELL') =>
                    v === 'BUY' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>,
                },
                {
                  title: '持仓',
                  dataIndex: 'positionSide',
                  width: 80,
                  render: (v: 'LONG' | 'SHORT' | undefined, row) =>
                    row.reduceOnly ? (
                      <Tag color="orange">平仓</Tag>
                    ) : v ? (
                      v === 'LONG' ? <Tag color="green">多头</Tag> : <Tag color="red">空头</Tag>
                    ) : null,
                },
                {
                  title: '价格',
                  dataIndex: 'price',
                  width: 120,
                  render: (v: number) => <span className="num">{v.toFixed(2)}</span>,
                },
                {
                  title: '数量',
                  dataIndex: 'quantity',
                  width: 120,
                  render: (v: number) => <span className="num">{v.toFixed(6)}</span>,
                },
                {
                  title: '手续费',
                  dataIndex: 'fee',
                  width: 100,
                  render: (v: number) => <span className="num text-muted">{v.toFixed(2)}</span>,
                },
                {
                  title: '置信度',
                  dataIndex: 'decisionConfidence',
                  width: 90,
                  render: (v: number) => <span className="num">{v.toFixed(2)}</span>,
                },
                {
                  title: '成交后权益',
                  dataIndex: 'equityAfter',
                  width: 130,
                  render: (v: number) => <span className="num text-btc-light">{v.toFixed(2)}</span>,
                },
              ]}
            />
          </Card>
        </>
      ) : null}

      {!report && !runBacktest.isPending ? (
        <div className="glass-card p-8 text-center text-[12px] text-muted">
          <Space direction="vertical" size={4}>
            <span>选择区间与策略后点击「运行回测」。</span>
            <span>
              数据缺失时自动从 Binance 公共接口回填（首次较慢）；成交口径为信号后下一根开盘价，无前视偏差。
            </span>
          </Space>
        </div>
      ) : null}
    </div>
  );
}
