import { Button, Card, Col, InputNumber, Row, Slider, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import { PlayCircleOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  useFuturesConfig,
  useFuturesHealth,
  useFuturesMargin,
  useFuturesPositions,
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

  const cfg = config.data;

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
            <div className="text-[14px] text-white">{cfg?.strategyName ?? '--'}</div>
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">决策链路</div>
            <Tag color={cfg?.decisionLane === 'hybrid' ? 'geekblue' : 'default'}>
              {cfg?.decisionLane === 'hybrid' ? 'hybrid（AI 上下文）' : 'strategy（纯策略）'}
            </Tag>
          </Col>
        </Row>
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
            最后运行 {cfg ? formatTime('now') : '--'}
          </span>
        </div>
      </Card>
    </div>
  );
}
