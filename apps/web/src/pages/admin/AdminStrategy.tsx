import { useMemo, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
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
import { useNavigate } from 'react-router-dom';
import {
  DollarOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { DevDocsButton } from '@/components/DevDocsDrawer';
import {
  useCloseBasket,
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
  const navigate = useNavigate();
  const strategies = useStrategies();
  const status = useStrategyStatus();
  const start = useStartStrategy();
  const stop = useStopStrategy();
  const closeBasket = useCloseBasket();
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

  /**
   * 未平仓拦截提示。
   *
   * 「未平仓单」有两种性质，必须让用户明确区分：
   * - 本策略留下的（服务重启后 runner 状态丢失）→ 可「接管并启动」继续管理
   * - 别的策略留下的 → 必须先手动了结，否则两套策略的仓位无法归因
   */
  const showBlockingLots = (
    strategy: StrategyDescriptor,
    params: Record<string, unknown> | undefined,
    lots: BlockingLot[],
    text: string,
    symbol?: string,
  ) => {
    modal.confirm({
      title: '还有仓位单未平仓',
      width: 720,
      okText: '接管并启动',
      okButtonProps: { danger: true },
      cancelText: '取消',
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
                // 拦截项来自交易所持仓快照，不带开仓时间
                render: (v: string) => (v ? formatTime(v) : '—'),
              },
            ]}
          />
          <div className="text-[12px] text-muted">
            若这些仓位是本策略留下的（例如服务重启），点「接管并启动」继续由它管理；
            否则请先到「合约面板」逐个平仓。
          </div>
        </div>
      ),
      onOk: () => doStart(strategy, params, true, symbol),
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

  const doStart = (
    strategy: StrategyDescriptor,
    params?: Record<string, unknown>,
    adoptExisting?: boolean,
    /** 指定币种启动独立实例；缺省用平台配置币种（兼容旧语义） */
    symbol?: string,
  ) =>
    confirmLiveIfNeeded(() => requireAuth(async () => {
      try {
        const result = await start.mutateAsync({ name: strategy.name, params, adoptExisting, symbol });
        if (!result.ok) {
          if (result.blockingLots?.length) {
            showBlockingLots(strategy, params, result.blockingLots, result.message);
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

  /**
   * 一键平仓：平掉当前篮子全部持仓，策略继续运行并自动开始下一轮。
   * 必须二次确认——这是真实资金操作，且与「停止策略」语义完全不同。
   */
  const doCloseBasket = () =>
    requireAuth(() => {
      modal.confirm({
        title: '一键平仓（了结当前这一轮）',
        icon: <ExclamationCircleOutlined className="text-down" />,
        width: 460,
        content: (
          <div className="space-y-1.5 text-[12px] leading-relaxed">
            <div>
              将平掉当前篮子的 <b>{st?.openLotCount ?? 0}</b> 个仓位单，并撤销全部未成交挂单。
            </div>
            <div>
              平仓后策略<b>继续运行</b>，下一轮挂单会自动开始。
            </div>
            <div className="text-muted">
              与「停止策略」不同：停止会保留持仓且不再交易，平仓是了结本轮后继续跑。
            </div>
          </div>
        ),
        okText: '确认平仓',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            const r = await closeBasket.mutateAsync();
            message.success(r.message);
          } catch (err) {
            message.error((err as Error).message);
          }
        },
      });
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
      {/* 页头：只回答「有哪些策略」，运行状态与绩效在详情页 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-white">策略管理</h2>
          <div className="muted-text mt-0.5">
            选一个策略 → 点「启动」挂载 → 进入「详情」看运行状态、阶梯与绩效
          </div>
        </div>
        <Space>
          <DevDocsButton />
          {running ? (
            <Tag color="processing" className="!mr-0">
              {st?.label} 运行中
            </Tag>
          ) : (
            <Tag className="!mr-0">未运行</Tag>
          )}
        </Space>
      </div>

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
                    onClick={() => {
                      if (running) {
                        // 多实例语义：已有实例运行时不再硬拦——
                        // 打开配置弹窗，用户改个币种就能启动新实例
                        setConfiguring(s);
                        form.setFieldsValue(s.defaultParams);
                        return;
                      }
                      void doStart(s, s.defaultParams);
                    }}
                  >
                    <PlayCircleOutlined /> 启动
                  </span>,
                  <span key="detail" onClick={() => navigate(`/admin/strategy/${s.name}`)}>
                    <FileTextOutlined /> 详情
                  </span>,
                  <span
                    key="backtest"
                    onClick={() => navigate(`/admin/backtest?strategy=${encodeURIComponent(s.name)}`)}
                  >
                    <ExperimentOutlined /> 回测
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
        onOk={() =>
          void form.validateFields().then((v) => {
            if (!configuring) return;
            // symbol 是运行实例的保留字段（不传给策略参数），其余交给策略参数
            const { symbol, ...params } = v as Record<string, unknown>;
            const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
            doStart(configuring, params, undefined, sym || undefined);
          })
        }
        width={680}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={
            configuring
              ? { ...configuring.defaultParams, symbol: futuresCfg?.symbol ?? 'BTCUSDT' }
              : undefined
          }
        >
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="symbol"
                label="运行币种"
                tooltip="每个「策略 + 币种」是一个独立实例，各自管理各自的仓位；同策略可同时跑多个币种"
                rules={[{ required: true, message: '请输入交易对，如 BTCUSDT' }]}
              >
                <Input placeholder="BTCUSDT" />
              </Form.Item>
            </Col>
          </Row>
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
