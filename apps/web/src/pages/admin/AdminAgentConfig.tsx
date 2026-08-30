import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Space,
  Row,
  Segmented,
  Select,
  Slider,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import { PlayCircleOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  DEFAULT_AGENT_CONFIG,
  EXCHANGE_LABELS,
  SPOT_EXCHANGE_CODES,
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  strategyRegistry,
  type AgentConfigShape,
  type DecisionLane,
  type RunMode,
} from '@ai-trader/shared';
import {
  useAccounts,
  useAgentState,
  useRunAgent,
  useToggleAgent,
  useUpdateAgentConfig,
} from '@/api/hooks';
import { useRequireAuth } from '@/components/AuthGate';
import { AccountEnvBadge } from '@/components/StatusBits';

const MODE_OPTIONS: { label: string; value: RunMode }[] = [
  { label: '模拟撮合', value: 'dry_run' },
  { label: '模拟盘/测试网', value: 'testnet' },
  { label: '实盘', value: 'live' },
];

// 注：原「AI 决策」（AI 直出 BUY/SELL）链路已移除——不可回测、不可复现。
// 两条链路的买卖都由确定性策略执行，区别仅在于策略参数是否经 AI 元参数调节。
const LANE_OPTIONS: { label: string; value: DecisionLane }[] = [
  { label: '纯策略', value: 'strategy' },
  { label: '混合', value: 'hybrid' },
];

export function AdminAgentConfig() {
  const { data } = useAgentState();
  // 未登录时接口返回 401，这里静默降级为「不展示环境徽标」
  const { data: exchanges } = useAccounts();
  const update = useUpdateAgentConfig();
  const toggle = useToggleAgent();
  const run = useRunAgent();
  const { message } = AntApp.useApp();
  const { run: requireAuth, modal } = useRequireAuth();
  const [form] = Form.useForm<AgentConfigShape>();
  const [dirty, setDirty] = useState(false);

  const config = data?.config;

  useEffect(() => {
    if (config) {
      // antd 的 RecursivePartial 对 Record<string, unknown> 字段推导过窄，这里断言回参数类型
      form.setFieldsValue(config as Parameters<typeof form.setFieldsValue>[0]);
      setDirty(false);
    }
  }, [config, form]);

  const save = async () => {
    const values = await form.validateFields();
    try {
      await update.mutateAsync(values);
      message.success('配置已保存');
      setDirty(false);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onToggle = (checked: boolean) =>
    requireAuth(() => {
      toggle.mutate(checked, {
        onSuccess: () => message.success(checked ? 'Agent 已启动' : 'Agent 已停止'),
        onError: (err) => message.error(err.message),
      });
    });

  const onRun = () =>
    requireAuth(() => {
      run.mutate(undefined, {
        onSuccess: (summary) =>
          message.success(
            `决策完成：${summary.action} · 置信度 ${(summary.confidence * 100).toFixed(0)}%`,
          ),
        onError: (err) => message.error(err.message),
      });
    });

  const modeValue = Form.useWatch('mode', form) ?? config?.mode ?? DEFAULT_AGENT_CONFIG.mode;
  const laneValue: DecisionLane =
    Form.useWatch('decisionLane', form) ?? config?.decisionLane ?? DEFAULT_AGENT_CONFIG.decisionLane;
  const strategyOptions = useMemo(() => strategyRegistry.list(), []);
  const strategyFormValue: string =
    Form.useWatch('strategyName', form) ?? config?.strategyName ?? DEFAULT_AGENT_CONFIG.strategyName;
  const currentStrategy = strategyOptions.find((s) => s.name === strategyFormValue);

  // 现货 Agent 的下单通道只列现货交易所：合约是独立链路，
  // 混选会让现货引擎拿合约账户去下单（当前合约适配器尚不支持交易）
  const exchangeOptions = useMemo(
    () => SPOT_EXCHANGE_CODES.map((code) => ({ label: EXCHANGE_LABELS[code], value: code })),
    [],
  );

  /** 当前启用账户的环境，用于在卡片右上角展示实际请求发往哪个环境 */
  const selectedExchange = exchanges?.find((item) => item.enabled) ?? exchanges?.[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
            <ThunderboltOutlined className="text-btc-light" />
            {config?.name ?? 'Agent'}
            <Tag color={config?.enabled ? 'green' : 'default'}>
              {config?.enabled ? '运行中' : '已停止'}
            </Tag>
          </div>
          <div className="muted-text mt-1">
            最近运行：{data?.lastRunAt ? new Date(data.lastRunAt).toLocaleString('zh-CN') : '尚未运行'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checkedChildren="启用"
            unCheckedChildren="停用"
            checked={config?.enabled ?? false}
            onChange={onToggle}
            loading={toggle.isPending}
          />
          <Button
            icon={<PlayCircleOutlined />}
            loading={run.isPending}
            onClick={onRun}
            className="!border-btc/40 !bg-btc/12 !text-btc-light"
          >
            立即决策
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={update.isPending}
            onClick={() => requireAuth(save)}
            className="!bg-btc-gradient !border-none !text-ink-900"
          >
            保存配置
          </Button>
        </div>
      </div>

      <Form
        form={form}
        layout="vertical"
        initialValues={DEFAULT_AGENT_CONFIG}
        onValuesChange={() => setDirty(true)}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card
              title="基础配置"
              className="glass-card"
              extra={
                selectedExchange ? (
                  <AccountEnvBadge environment={selectedExchange.environment} />
                ) : null
              }
            >
              <Form.Item name="name" label="Agent 名称" rules={[{ required: true }]}>
                <Input placeholder="BTC 主力 Agent" />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="symbol" label="交易对" rules={[{ required: true }]}>
                    <Input placeholder="BTCUSDT" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="timeframe" label="决策周期粒度" rules={[{ required: true }]}>
                    <Select
                      options={TIMEFRAMES.map((tf) => ({ label: TIMEFRAME_LABELS[tf], value: tf }))}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="decisionIntervalSec" label="决策轮询间隔（秒）">
                    <InputNumber min={30} max={86400} className="!w-full" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="mode" label="运行模式">
                    <Select options={MODE_OPTIONS} />
                  </Form.Item>
                </Col>
              </Row>
              {modeValue === 'live' ? (
                <div className="mb-3 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[12px] text-down">
                  实盘模式会真实动用资金。自动轮询不会在实盘模式直接下单（需二次确认 Token），仅手动调用接口时生效。
                </div>
              ) : null}
              <Form.Item name="enabledExchanges" label="启用交易所">
                <Select mode="multiple" options={exchangeOptions} placeholder="选择下单通道" />
              </Form.Item>
              <Form.Item
                name="decisionLane"
                label={
                  <Tooltip title="strategy=纯技术指标策略，零 LLM 成本；hybrid=AI 只输出市场状态元参数（1 小时缓存），映射为策略参数后由策略执行，AI 挂掉自动回落中性默认参数不停摆。两条链路的买卖都由策略执行，AI 不直出买卖指令">
                    <span className="border-b border-dashed border-white/25">决策链路</span>
                  </Tooltip>
                }
              >
                <Segmented options={LANE_OPTIONS} />
              </Form.Item>
              {/* 两条链路由策略执行，策略选择器始终显示 */}
              <Form.Item
                name="strategyName"
                label="策略"
                tooltip={laneValue === 'hybrid' ? 'hybrid 链路由该策略执行交易，AI 只调节其参数' : 'strategy 链路由该策略全权决策，零 LLM 参与'}
              >
                <Select
                  options={strategyOptions.map((s) => ({
                    label: `${s.label}（${s.name}）`,
                    value: s.name,
                  }))}
                />
              </Form.Item>
              {currentStrategy?.paramSchema ? (
                <>
                  <div className="mb-1 mt-2 text-[12px] text-subtle">策略参数</div>
                  <Row gutter={12}>
                    {Object.entries(
                      currentStrategy.paramSchema.properties as Record<
                        string,
                        { title?: string; minimum?: number; maximum?: number }
                      >,
                    ).map(([key, prop]) => (
                      <Col span={8} key={key}>
                        <Form.Item
                          name={['strategyParams', key]}
                          label={prop.title ?? key}
                          tooltip={`范围 ${prop.minimum ?? '-'} ~ ${prop.maximum ?? '-'}；留空使用默认值 ${
                            currentStrategy.defaultParams?.[key] ?? '-'
                          }`}
                        >
                          <InputNumber
                            min={prop.minimum}
                            max={prop.maximum}
                            step={0.01}
                            placeholder={String(currentStrategy.defaultParams?.[key] ?? '默认')}
                            className="!w-full"
                          />
                        </Form.Item>
                      </Col>
                    ))}
                  </Row>
                </>
              ) : null}
              <Form.Item name="positionPct" label="单次仓位比例">
                <Slider
                  min={0.01}
                  max={1}
                  step={0.01}
                  marks={{ 0.1: '10%', 0.3: '30%', 0.5: '50%', 1: '100%' }}
                  tooltip={{ formatter: (v) => `${((v ?? 0) * 100).toFixed(0)}%` }}
                />
              </Form.Item>
              <Form.Item name="minConfidence" label="触发下单的最低置信度">
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  marks={{ 0.3: '0.3', 0.6: '0.6', 0.9: '0.9' }}
                  tooltip={{ formatter: (v) => (v ?? 0).toFixed(2) }}
                />
              </Form.Item>
              <Form.Item
                label={
                  <Tooltip title="出场规则属于持仓层能力，两条链路均生效且优先级最高：持仓亏损/盈利达到阈值时全仓卖出，替代本轮策略或模型信号。留空表示关闭该项。">
                    <span className="border-b border-dashed border-white/25">出场规则（止损/止盈）</span>
                  </Tooltip>
                }
              >
                <Space.Compact>
                  <Form.Item
                    name={['exitRules', 'stopLossPct']}
                    noStyle
                  >
                    <InputNumber
                      min={0.001}
                      max={1}
                      step={0.01}
                      placeholder="止损，如 0.05"
                      className="!w-44"
                    />
                  </Form.Item>
                  <Form.Item
                    name={['exitRules', 'takeProfitPct']}
                    noStyle
                  >
                    <InputNumber
                      min={0.001}
                      max={1}
                      step={0.01}
                      placeholder="止盈，如 0.10"
                      className="!w-44"
                    />
                  </Form.Item>
                </Space.Compact>
              </Form.Item>
              <div className="rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-muted">
                值为相对持仓均价的小数：0.05 = 亏损 5% 止损、0.10 = 盈利 10% 止盈；清空 = 关闭。
                默认全关：出场会主动平仓，请确认策略配合后再启用。
              </div>
            </Card>
          </Col>

          <Col xs={24} xl={12}>
            {laneValue === 'strategy' ? (
              <Card title="策略配置" className="glass-card">
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-[12px] leading-relaxed text-muted">
                  当前链路为「纯策略」：决策完全由上方选定的策略产出，不调用 LLM
                  （不读密钥、不发请求、零 token 成本），LLM 挂掉也不影响本链路。
                  策略使用内置默认参数（左侧可配置出场规则）；参数编辑与回测报告页在后续版本提供。
                </div>
              </Card>
            ) : laneValue === 'hybrid' ? (
              <Card title="AI 上下文（hybrid）" className="glass-card">
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-[12px] leading-relaxed text-muted">
                  当前链路为「混合」：AI 不直接下达买卖指令，只输出市场状态元参数
                  （趋势/震荡/高波动、激进度、新闻情绪），经确定性映射调节上方策略的
                  阈值与仓位（0.5~1.5 倍）后由策略执行。结果可回测、可审计。
                  <br />
                  <br />
                  AI 分析结果缓存 1 小时；AI 失败或超期时自动沿用上次分析，再退一步
                  则使用中性默认参数，交易不会停摆。上下文分析仍需调用模型，见下方模型配置。
                </div>
              </Card>
            ) : (
              <Card title="模型配置" className="glass-card">
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item name="model" label="模型">
                      <Input placeholder="deepseek-chat" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="maxTokens" label="最大 Token">
                      <InputNumber min={128} max={8192} className="!w-full" />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="temperature" label="温度">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    marks={{ 0: '0', 0.5: '0.5', 1: '1' }}
                    tooltip={{ formatter: (v) => (v ?? 0).toFixed(2) }}
                  />
                </Form.Item>
                <Form.Item
                  name="systemPrompt"
                  label={
                    <Tooltip title="模型的角色与纪律约束，会作为 system 消息发送">
                      <span className="border-b border-dashed border-white/25">系统提示词</span>
                    </Tooltip>
                  }
                >
                  <Input.TextArea rows={6} />
                </Form.Item>
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-muted">
                  模型不可用（未配置密钥 / 调用失败）时，按「LLM 失败时的行为」处理；
                  标记为
                  <Tag color="orange" className="!mx-1">
                    降级
                  </Tag>
                  并写入降级原因，不再静默切换链路。
                </div>
              </Card>
            )}
            {laneValue === 'hybrid' ? (
              <Card title="模型配置" className="glass-card" style={{ marginTop: 16 }}>
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item name="model" label="模型">
                      <Input placeholder="deepseek-chat" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="maxTokens" label="最大 Token">
                      <InputNumber min={128} max={8192} className="!w-full" />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="temperature" label="温度">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    marks={{ 0: '0', 0.5: '0.5', 1: '1' }}
                    tooltip={{ formatter: (v) => (v ?? 0).toFixed(2) }}
                  />
                </Form.Item>
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-muted">
                  该模型仅用于生成市场状态分析（低频，约每小时一次），不输出买卖指令。
                </div>
              </Card>
            ) : null}
          </Col>

          <Col span={24}>
            <Card title="风控配置" className="glass-card">
              <Row gutter={[16, 0]}>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="maxOrderAmount" label="单笔最大金额（USDT）">
                    <InputNumber min={0} className="!w-full" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="maxDailyOrders" label="单日最大下单笔数">
                    <InputNumber min={0} className="!w-full" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="minOrderIntervalSec" label="最小下单间隔（秒）">
                    <InputNumber min={0} className="!w-full" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Form.Item name="dailyLossLimit" label="日亏损上限（USDT）">
                    <InputNumber min={0} className="!w-full" />
                  </Form.Item>
                </Col>
                <Col xs={24} lg={6}>
                  <Form.Item name="maxDrawdownPct" label="最大回撤熔断（%）">
                    <InputNumber min={0} max={100} className="!w-full" />
                  </Form.Item>
                </Col>
              </Row>
              <Divider className="!my-2 !border-white/[0.06]" />
              <div className="muted-text">
                所有下单（含 Agent 自动单与后台手动单）都会经过同一套风控校验：单笔金额 → 下单间隔 → 每日笔数 →
                日亏损 → 回撤熔断 → 可用余额。被拦截时会生成风控事件并写入决策记录。
              </div>
            </Card>
          </Col>
        </Row>
      </Form>

      {dirty ? (
        <div className="fixed bottom-6 right-6 z-40 rounded-xl border border-btc/40 bg-ink-800/95 px-4 py-3 shadow-glow backdrop-blur">
          <span className="text-[12px] text-subtle">配置有未保存的改动</span>
          <Button
            size="small"
            type="primary"
            className="!ml-3 !bg-btc-gradient !border-none !text-ink-900"
            loading={update.isPending}
            onClick={() => requireAuth(save)}
          >
            保存
          </Button>
        </div>
      ) : null}

      {modal}
    </div>
  );
}
