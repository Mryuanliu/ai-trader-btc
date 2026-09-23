import { useMemo, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import {
  ExclamationCircleOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  useFuturesConfig,
  useStartStrategy,
  useStopStrategy,
  useStrategies,
  useStrategyStatus,
} from '@/api/hooks';
import { useRequireAuth } from '@/components/AuthGate';
import { formatPrice, formatTime } from '@/utils/format';
import type { BlockingLot, StrategyDescriptor } from '@ai-trader/shared';

/**
 * 策略管理（策略合集卡片页）。
 *
 * 交互：点击「启动」即挂载该策略开始运行——平台不再有决策引擎，
 * 启动即代表策略按自己的节奏直接下单。
 *
 * 拦截：若还有未平仓的仓位单（上一个策略留下的），启动会被拦下并列出明细，
 * 需要用户先在合约面板手动平掉，避免两套策略的仓位混在一起无法归因。
 */
export function AdminStrategy() {
  const strategies = useStrategies();
  const status = useStrategyStatus();
  const start = useStartStrategy();
  const stop = useStopStrategy();
  /** 运行模式：切到实盘时启动策略需要二次确认 */
  const futuresCfg = useFuturesConfig().data;
  const { message, modal } = AntApp.useApp();
  const { run: requireAuth } = useRequireAuth();

  /** 正在配置参数的策略（弹窗） */
  const [configuring, setConfiguring] = useState<StrategyDescriptor | null>(null);
  // 参数值来自 JSON Schema（动态类型），用宽松类型承接，避免 antd 强类型断言
  const [form] = Form.useForm<Record<string, any>>();

  const st = status.data;
  const running = st?.running ?? false;

  /** 把未平仓拦截的明细渲染成表格 */
  const showBlockingLots = (lots: BlockingLot[], text: string) => {
    modal.warning({
      title: '还有仓位单未平仓',
      width: 720,
      okText: '知道了',
      content: (
        <div className="space-y-3">
          <div className="text-[12px] text-muted">{text}</div>
          <Table<BlockingLot>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={lots}
            columns={[
              {
                title: '方向',
                dataIndex: 'direction',
                width: 70,
                render: (d: string) => (
                  <Tag color={d === 'LONG' ? 'green' : 'red'}>{d === 'LONG' ? '多' : '空'}</Tag>
                ),
              },
              { title: '数量', dataIndex: 'quantity', render: (v: number) => v.toFixed(6) },
              {
                title: '开仓价',
                dataIndex: 'entryPrice',
                render: (v: number) => formatPrice(v),
              },
              {
                title: '浮动盈亏',
                dataIndex: 'unrealizedPnl',
                render: (v: number) => (
                  <span className={v >= 0 ? 'text-up' : 'text-down'}>{v.toFixed(4)}</span>
                ),
              },
              {
                title: '开仓时间',
                dataIndex: 'openedAt',
                render: (v: string) => formatTime(v),
              },
            ]}
          />
          <div className="text-[12px] text-muted">
            请到「合约面板」逐个平仓，全部了结后即可启动新策略。
          </div>
        </div>
      ),
    });
  };

  /**
   * 实盘启动前的二次确认。
   *
   * 平台不做风控拦截，所以「即将用真实资金自动交易」这件事必须在
   * 交互层拦一道，避免误点启动。
   */
  const confirmLiveIfNeeded = (onOk: () => void) => {
    if (futuresCfg?.mode !== 'live') {
      onOk();
      return;
    }
    modal.confirm({
      title: '以实盘模式启动策略？',
      icon: <ExclamationCircleOutlined className="text-down" />,
      width: 480,
      content: (
        <div className="text-[12px] leading-relaxed">
          当前运行模式为 <b>live（实盘）</b>，启动后该策略将
          <b>用真实资金自动下单</b>，且平台不会拦截任何交易。
        </div>
      ),
      okText: '确认启动',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk,
    });
  };

  const doStart = (strategy: StrategyDescriptor, params?: Record<string, unknown>) =>
    confirmLiveIfNeeded(() => requireAuth(async () => {
      try {
        const result = await start.mutateAsync({ name: strategy.name, params });
        if (!result.ok) {
          if (result.blockingLots?.length) {
            showBlockingLots(result.blockingLots, result.message);
          } else {
            message.error(result.message);
          }
          return;
        }
        message.success(result.message);
        setConfiguring(null);
      } catch (err) {
        message.error((err as Error).message);
      }
    }));

  const doStop = () =>
    requireAuth(async () => {
      try {
        await stop.mutateAsync();
        message.success('策略已停止。已有持仓不会被自动平掉，请到合约面板手动处理。');
      } catch (err) {
        message.error((err as Error).message);
      }
    });

  /** 参数表单：按 paramSchema 动态渲染（number / boolean / enum） */
  const paramFields = useMemo(() => {
    const schema = configuring?.paramSchema as
      | { properties?: Record<string, Record<string, unknown>> }
      | undefined;
    const props = schema?.properties ?? {};
    return Object.entries(props).map(([key, spec]) => {
      const type = String(spec.type ?? 'number');
      const title = String(spec.title ?? key);
      const tip = [spec.minimum !== undefined ? `最小 ${spec.minimum}` : '', spec.maximum !== undefined ? `最大 ${spec.maximum}` : '']
        .filter(Boolean)
        .join('，');
      return { key, type, title, tip, spec };
    });
  }, [configuring]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[17px] font-semibold text-white">策略管理</h2>
          <div className="muted-text mt-0.5">
            点击启动即挂载策略开始自动交易；同一时间只能运行一个策略
          </div>
        </div>
        {running ? (
          <Space>
            <Tag color="processing" className="!mr-0">
              {st?.label} 运行中
            </Tag>
            <Button
              danger
              icon={<PoweroffOutlined />}
              loading={stop.isPending}
              onClick={doStop}
            >
              停止策略
            </Button>
          </Space>
        ) : (
          <Tag>未运行</Tag>
        )}
      </div>

      {/* 运行中状态 */}
      {running && st ? (
        <Card size="small" title="运行状态" className="!border-white/[0.06] !bg-white/[0.02]">
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Stat label="未完结仓位单" value={String(st.openLotCount)} />
            </Col>
            <Col xs={12} md={6}>
              <Stat label="启动时间" value={st.startedAt ? formatTime(st.startedAt) : '--'} />
            </Col>
            <Col xs={12} md={6}>
              <Stat label="最近 tick" value={st.lastTickAt ? formatTime(st.lastTickAt) : '--'} />
            </Col>
            <Col xs={12} md={6}>
              <Stat
                label="篮子净收益率峰值"
                value={
                  st.state && typeof st.state.basketPeakPct === 'number'
                    ? `${(st.state.basketPeakPct * 100).toFixed(2)}%`
                    : '--'
                }
              />
            </Col>
          </Row>
          {st.state && typeof st.state.note === 'string' && st.state.note ? (
            <div className="mt-3 text-[12px] text-subtle">
              <span className="muted-text">最近动作：</span>
              {st.state.note}
            </div>
          ) : null}
          {st.lastError ? (
            <Alert
              className="mt-3"
              type="error"
              showIcon
              message="最近一次 tick 失败"
              description={st.lastError}
            />
          ) : null}
        </Card>
      ) : null}

      {/* 策略卡片 */}
      {strategies.isLoading ? (
        <Card className="!border-white/[0.06] !bg-white/[0.02]">加载中…</Card>
      ) : (strategies.data ?? []).length === 0 ? (
        <Card className="!border-white/[0.06] !bg-white/[0.02]">
          <Empty description="暂无可用的策略" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {(strategies.data ?? []).map((s) => (
            <Col key={s.name} xs={24} lg={12} xl={8}>
              <Card
                className="!border-white/[0.06] !bg-white/[0.02] transition-colors hover:!border-btc/40"
                title={
                  <div className="flex items-center gap-2">
                    <span className="text-white">{s.label}</span>
                    <Tag className="!mr-0">{s.name}</Tag>
                  </div>
                }
                actions={[
                  <Tooltip title="启动前可调整参数" key="config">
                    <span
                      onClick={() => {
                        setConfiguring(s);
                        form.setFieldsValue(s.defaultParams);
                      }}
                    >
                      <SettingOutlined /> 参数配置
                    </span>
                  </Tooltip>,
                  <span
                    key="start"
                    className={running ? 'cursor-not-allowed opacity-40' : ''}
                    onClick={() => {
                      if (running) {
                        message.warning('已有策略在运行，请先停止');
                        return;
                      }
                      void doStart(s, s.defaultParams);
                    }}
                  >
                    <PlayCircleOutlined /> 启动
                  </span>,
                ]}
              >
                <div className="min-h-[48px] text-[12px] leading-relaxed text-subtle">
                  {s.description}
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 参数配置弹窗 */}
      <Modal
        open={configuring !== null}
        title={`${configuring?.label ?? ''} · 参数配置`}
        okText="保存并启动"
        cancelText="取消"
        confirmLoading={start.isPending}
        onCancel={() => setConfiguring(null)}
        onOk={() => void form.validateFields().then((v) => configuring && doStart(configuring, v))}
        width={680}
      >
        <Form form={form} layout="vertical" initialValues={configuring?.defaultParams}>
          <Row gutter={16}>
            {paramFields.map(({ key, type, title, tip }) => (
              <Col xs={24} md={12} key={key}>
                <Form.Item
                  name={key}
                  label={title}
                  tooltip={tip || undefined}
                  valuePropName={type === 'boolean' ? 'checked' : 'value'}
                >
                  {type === 'boolean' ? (
                    <Switch />
                  ) : type === 'integer' || type === 'number' ? (
                    <InputNumber className="!w-full" />
                  ) : (
                    <Select
                      options={(
                        (configuring?.paramSchema as { properties?: Record<string, { enum?: string[] }> })
                          ?.properties?.[key]?.enum ?? []
                      ).map((v) => ({ value: v, label: v }))}
                    />
                  )}
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted-text">{label}</div>
      <div className="num mt-0.5 text-[14px] text-white">{value}</div>
    </div>
  );
}
