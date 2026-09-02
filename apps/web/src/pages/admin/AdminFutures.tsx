import { useMemo } from 'react';
import { Button, Card, Col, InputNumber, Row, Select, Slider, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import { PlayCircleOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  useBacktestStrategies,
  useFuturesConfig,
  useFuturesHealth,
  useFuturesMargin,
  useFuturesPositions,
  useOpenLots,
  useRunFuturesEngine,
  useUpdateFuturesConfig,
} from '@/api/hooks';
import { formatPrice, formatTime } from '@/utils/format';
import { DEFAULT_FUTURES_AGENT_CONFIG } from '@ai-trader/shared';

/**
 * 合约面板（独立链路）。
 *
 * 与现货 Agent 配置完全独立：独立开关、独立策略、独立杠杆与保证金模式。
 * 持仓以交易所 positionRisk 为权威（支持做空、强平价、逐仓保证金）。
 */
export function AdminFutures() {
  const config = useFuturesConfig();
  const margin = useFuturesMargin();
  const positions = useFuturesPositions();
  const health = useFuturesHealth();
  const update = useUpdateFuturesConfig();
  const run = useRunFuturesEngine();
  const strategies = useBacktestStrategies();
  // 本地合约仓位单（Lot）：订单级独立止盈止损，与交易所净持仓对照
  const { data: futuresLots = [] } = useOpenLots({ market: 'futures' });

  const cfg = config.data;

  /** 当前选中策略（含 paramSchema，用于动态渲染参数编辑表单） */
  const currentStrategy = useMemo(
    () => strategies.data?.find((s) => s.name === cfg?.strategyName) ?? strategies.data?.[0],
    [strategies.data, cfg?.strategyName],
  );
  const paramProps = (currentStrategy?.paramSchema?.properties ?? {}) as Record<
    string,
    { type?: string; minimum?: number; maximum?: number; title?: string }
  >;

  /** 保存单个策略参数（合并进现有 strategyParams） */
  const saveParam = (key: string, value: number | null) => {
    const merged = { ...(cfg?.strategyParams ?? {}), [key]: value == null ? undefined : value };
    if (value == null) delete merged[key];
    savePatch({ strategyParams: merged });
  };

  const saveEnabled = (checked: boolean) => {
    update.mutate({ enabled: checked }, { onError: (e) => message.error(e.message) });
  };

  const savePatch = (patch: Record<string, unknown>) => {
    update.mutate(patch, { onError: (e) => message.error(e.message) });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ThunderboltOutlined className="text-btc" />
          <span className="text-[15px] font-semibold">币安合约面板</span>
          <Tag color={cfg?.enabled ? 'green' : 'default'}>{cfg?.enabled ? '运行中' : '已停止'}</Tag>
          {health.data?.tripped ? <Tag color="red">已熔断</Tag> : null}
        </div>
        <Space>
          <Switch checked={cfg?.enabled} onChange={saveEnabled} checkedChildren="启用" unCheckedChildren="停用" />
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={run.isPending}
            onClick={() => run.mutate(undefined, { onError: (e) => message.error(e.message) })}
          >
            手动触发一次决策
          </Button>
        </Space>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">可用保证金</div>
          <div className="num text-[20px] font-semibold text-white">
            {margin.data?.available?.toFixed(2) ?? '--'}
          </div>
          <div className="text-[11px] text-muted">USDT</div>
        </Card>
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">当前杠杆</div>
          <div className="num text-[20px] font-semibold text-white">{cfg?.leverage ?? '--'}x</div>
          <div className="text-[11px] text-muted">上限 {cfg?.maxLeverage ?? '--'}x</div>
        </Card>
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">保证金模式</div>
          <div className="num text-[20px] font-semibold text-white">
            {cfg?.marginType === 'isolated' ? '逐仓' : '全仓'}
          </div>
          <div className="text-[11px] text-muted">逐仓单仓风险隔离</div>
        </Card>
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">熔断状态</div>
          <div className={`text-[20px] font-semibold ${health.data?.tripped ? 'text-down' : 'text-up'}`}>
            {health.data?.tripped ? '熔断中' : health.data?.running ? '运行中' : '正常'}
          </div>
          <div className="text-[11px] text-muted">
            连续失败 {health.data?.consecutiveFailures ?? 0} 次
          </div>
        </Card>
      </div>

      <Card title="合约持仓（以交易所 positionRisk 为权威）" className="glass-card" size="small">
        <Table
          size="small"
          rowKey="symbol"
          dataSource={(positions.data ?? []).filter((p) => Math.abs(p.quantity) > 0)}
          locale={{ emptyText: '当前无持仓' }}
          pagination={false}
          columns={[
            {
              title: '标的', dataIndex: 'symbol', width: 110,
              render: (v: string) => <b>{v}</b>,
            },
            {
              title: '方向', dataIndex: 'positionSide', width: 80,
              render: (v: 'LONG' | 'SHORT') =>
                v === 'LONG' ? <Tag color="green">多头</Tag> : <Tag color="red">空头</Tag>,
            },
            {
              title: '数量', dataIndex: 'quantity', width: 110,
              render: (v: number) => <span className="num">{v.toFixed(6)}</span>,
            },
            {
              title: '开仓价', dataIndex: 'entryPrice', width: 120,
              render: (v: number) => <span className="num">{formatPrice(v)}</span>,
            },
            {
              title: '标记价', dataIndex: 'markPrice', width: 120,
              render: (v: number) => <span className="num">{formatPrice(v)}</span>,
            },
            {
              title: '名义价值', dataIndex: 'notional', width: 120,
              render: (v: number) => <span className="num">{v.toFixed(2)}</span>,
            },
            {
              title: '未实现盈亏', dataIndex: 'unrealizedPnl', width: 130,
              render: (v: number) => (
                <span className={`num ${v >= 0 ? 'text-up' : 'text-down'}`}>{v.toFixed(4)}</span>
              ),
            },
            {
              title: '杠杆', dataIndex: 'leverage', width: 70,
              render: (v: number) => `${v}x`,
            },
            {
              title: '强平价', dataIndex: 'liquidationPrice', width: 120,
              render: (v: number) => (v > 0 ? <span className="num text-down">{formatPrice(v)}</span> : <span className="text-muted">-</span>),
            },
            {
              title: '距强平', dataIndex: 'liquidationDistancePct', width: 90,
              render: (v: number | null) =>
                v === null ? <span className="text-muted">-</span> : (
                  <Tooltip title="多头看下跌空间，空头看上涨空间">
                    <span className={`num ${v < 0.15 ? 'text-down' : 'text-subtle'}`}>{(v * 100).toFixed(1)}%</span>
                  </Tooltip>
                ),
            },
          ]}
        />
      </Card>

      <Card
        title="合约仓位单（Lot，本地订单级）"
        className="glass-card"
        size="small"
        extra={<span className="text-[11px] text-muted">与上方交易所净持仓对照 · 每单独立止盈止损</span>}
      >
        <FuturesLotTotals lots={futuresLots} positions={positions.data ?? []} />
        <Table
          size="small"
          rowKey="id"
          dataSource={futuresLots}
          locale={{ emptyText: '当前没有持仓中的合约仓位单' }}
          pagination={false}
          columns={[
            {
              title: '方向', dataIndex: 'direction', width: 80,
              render: (v: 'LONG' | 'SHORT') =>
                v === 'LONG' ? <Tag color="green">做多</Tag> : <Tag color="red">做空</Tag>,
            },
            {
              title: '数量', dataIndex: 'quantity', width: 110,
              render: (v: number) => <span className="num">{v.toFixed(6)}</span>,
            },
            {
              title: '开仓价', dataIndex: 'entryPrice', width: 120,
              render: (v: number) => <span className="num">{formatPrice(v)}</span>,
            },
            {
              title: '止损/止盈', key: 'tpSl', width: 130,
              render: (_, row) => (
                <span className="num text-[11px] text-subtle">
                  SL {(row.stopLossPct * 100).toFixed(1)}% / TP {(row.takeProfitPct * 100).toFixed(1)}%
                </span>
              ),
            },
            {
              title: '浮动盈亏', key: 'pnl', width: 130,
              render: (_, row) =>
                row.unrealizedPnl === null ? (
                  <span className="text-muted">--</span>
                ) : (
                  <span className={`num ${row.unrealizedPnl >= 0 ? 'text-up' : 'text-down'}`}>
                    {row.unrealizedPnl.toFixed(4)}
                  </span>
                ),
            },
            {
              title: '开仓时间', dataIndex: 'openedAt', width: 140,
              render: (v: string) => <span className="num text-[11px] text-muted">{formatTime(v)}</span>,
            },
          ]}
        />
      </Card>

      <Card title="合约策略配置（与现货独立）" className="glass-card" size="small">
        <Row gutter={24}>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">开仓杠杆（1 ~ {cfg?.maxLeverage ?? 10}x）</div>
            <Slider
              min={1}
              max={cfg?.maxLeverage ?? 10}
              step={1}
              value={cfg?.leverage ?? 5}
              onChange={(v) => savePatch({ leverage: v })}
              marks={{ 1: '1x', 5: '5x', 10: '10x' }}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">保证金占用比例（positionPct）</div>
            <Slider
              min={0.01}
              max={1}
              step={0.01}
              value={cfg?.positionPct ?? 0.1}
              onChange={(v) => savePatch({ positionPct: v })}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">最低置信度</div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={cfg?.minConfidence ?? 0.6}
              onChange={(v) => savePatch({ minConfidence: v })}
            />
          </Col>
        </Row>
        <Row gutter={24} className="mt-2">
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">决策间隔（秒）</div>
            <InputNumber
              min={30}
              max={3600}
              step={30}
              value={cfg?.decisionIntervalSec}
              onChange={(v) => savePatch({ decisionIntervalSec: v })}
              className="!w-full"
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">策略（与现货同一策略体系）</div>
            <Select
              value={cfg?.strategyName}
              style={{ width: '100%' }}
              placeholder="选择策略"
              loading={strategies.isLoading}
              options={(strategies.data ?? []).map((s) => ({
                label: `${s.label}（${s.name}）`,
                value: s.name,
              }))}
              onChange={(v) => savePatch({ strategyName: v })}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">决策链路</div>
            <Select
              value={cfg?.decisionLane}
              style={{ width: '100%' }}
              options={[
                { label: 'strategy（纯策略，零 LLM）', value: 'strategy' },
                { label: 'hybrid（AI 上下文 + 策略）', value: 'hybrid' },
              ]}
              onChange={(v) => savePatch({ decisionLane: v })}
            />
          </Col>
        </Row>

        {/* 策略参数：按当前策略的 paramSchema 动态渲染，改完即保存 */}
        {Object.keys(paramProps).length > 0 ? (
          <div className="mt-4 rounded-xl border border-white/[0.07] bg-black/20 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-subtle">
                策略参数 · {currentStrategy?.label ?? cfg?.strategyName}
              </span>
              <Tooltip title="留空表示使用策略默认值；数值改完即时保存到 strategyParams。调整后建议先在「策略回测」里用相同参数验证再实盘。">
                <span className="cursor-help text-[11px] text-muted">修改需谨慎</span>
              </Tooltip>
            </div>
            <Row gutter={12}>
              {Object.entries(paramProps).map(([key, prop]) => {
                const isBool = prop.type === 'boolean';
                const current = (cfg?.strategyParams ?? {})[key];
                // 回填显示：自定义值优先，未设置时显示策略默认值（defaultParams）
                const display =
                  typeof current === 'number'
                    ? current
                    : (currentStrategy?.defaultParams?.[key] as number | undefined);
                return (
                  <Col span={8} key={key}>
                    <div className="mb-1 text-[11px] text-muted">{prop.title ?? key}</div>
                    {isBool ? (
                      <Switch
                        size="small"
                        checked={Boolean(current)}
                        onChange={(checked) => saveParam(key, checked ? 1 : 0)}
                      />
                    ) : (
                      <InputNumber
                        min={prop.minimum}
                        max={prop.maximum}
                        step={0.01}
                        value={display}
                        placeholder={String(currentStrategy?.defaultParams?.[key] ?? '')}
                        onChange={(v) => saveParam(key, v)}
                        className="!w-full"
                      />
                    )}
                  </Col>
                );
              })}
            </Row>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-subtle">{currentStrategy?.description ?? ''}</span>
              <Button
                size="small"
                type="text"
                onClick={() => {
                  // 恢复默认：清空 strategyParams，让策略用 normalizeParams 的默认值
                  if (Object.keys(cfg?.strategyParams ?? {}).length > 0) {
                    savePatch({ strategyParams: {} });
                  } else {
                    message.info('当前已是默认参数');
                  }
                }}
              >
                恢复默认参数
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex items-center gap-3">
          <Button
            size="small"
            icon={<SaveOutlined />}
            onClick={() => {
              const c = cfg ?? DEFAULT_FUTURES_AGENT_CONFIG;
              savePatch({
                leverage: c.leverage,
                positionPct: c.positionPct,
                minConfidence: c.minConfidence,
                decisionIntervalSec: c.decisionIntervalSec,
              });
            }}
          >
            保存当前参数
          </Button>
          <span className="text-[11px] text-muted">
            最后运行 {formatTime(cfg?.lastRunAt)}
          </span>
        </div>
      </Card>
    </div>
  );
}

/**
 * 合约仓位单净额对账：Σ多头量 − Σ空头量 = 本地净持仓，与交易所 positionRisk 对照。
 * 差异提示：用户手动在交易所开仓/平仓而本地无记录时，Lot 汇总会偏离交易所。
 */
function FuturesLotTotals({
  lots,
  positions,
}: {
  lots: { direction: string; quantity: number }[];
  positions: { positionSide: string | null; quantity: number }[];
}) {
  const longQty = lots.filter((l) => l.direction === 'LONG').reduce((a, l) => a + l.quantity, 0);
  const shortQty = lots.filter((l) => l.direction === 'SHORT').reduce((a, l) => a + l.quantity, 0);
  const lotNet = longQty - shortQty;

  const exLong = positions
    .filter((p) => p.positionSide === 'LONG')
    .reduce((a, p) => a + p.quantity, 0);
  const exShort = positions
    .filter((p) => p.positionSide === 'SHORT')
    .reduce((a, p) => a + p.quantity, 0);
  const exNet = exLong - exShort;

  const diff = Math.abs(lotNet - exNet);
  const mismatch = diff > 1e-6;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
      <span className="muted-text">本地 Lot 净额</span>
      <span className="num text-up">多 {longQty.toFixed(6)}</span>
      <span className="num text-down">空 {shortQty.toFixed(6)}</span>
      <span className="num text-white">净 {lotNet.toFixed(6)}</span>
      <span className="muted-text ml-2">交易所净持仓</span>
      <span className="num text-white">{exNet.toFixed(6)}</span>
      {mismatch ? (
        <Tag color="orange">
          对账差异 {diff.toFixed(6)}（本地与交易所不一致，多为手动单未入本地 Lot）
        </Tag>
      ) : (
        <Tag color="green">对账一致</Tag>
      )}
    </div>
  );
}
