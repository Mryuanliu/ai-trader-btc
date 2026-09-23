import { useState } from 'react';
import { App as AntApp, Button, Card, Col, InputNumber, Row, Select, Slider, Space, Switch, Table, Tag, Tooltip } from 'antd';
import { ExclamationCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  useFuturesConfig,
  useFuturesMargin,
  useFuturesPlaceOrder,
  useFuturesPositions,
  useOpenLots,
  useUpdateFuturesConfig,
} from '@/api/hooks';
import { useRequireAuth } from '@/components/AuthGate';
import { formatPrice, formatTime } from '@/utils/format';

/**
 * 合约面板。
 *
 * 平台侧只负责：链路开关、交易参数（杠杆/保证金模式）、持仓与仓位单的查看、
 * 手动平掉某个仓位单。**策略参数与启停请到「策略管理」页**——
 * 平台不做决策，也没有熔断。
 */
export function AdminFutures() {
  const config = useFuturesConfig();
  const margin = useFuturesMargin();
  const positions = useFuturesPositions();
  const update = useUpdateFuturesConfig();
  const place = useFuturesPlaceOrder();
  // 本地合约仓位单（Lot）：订单级独立止盈止损，与交易所净持仓对照
  const { data: futuresLots = [] } = useOpenLots({ market: 'futures' });
  const { message, modal } = AntApp.useApp();
  const { run: requireAuth } = useRequireAuth();
  /** 正在平仓的 Lot（用于按钮 loading 态） */
  const [closingLotId, setClosingLotId] = useState<string | null>(null);

  const cfg = config.data;

  /** 手动平掉指定 Lot：全量 reduceOnly，带精确 lotId */
  const closeLot = (lot: (typeof futuresLots)[number]) => {
    const entry = Number(lot.entryPrice);
    const qty = Number(lot.quantity);
    modal.confirm({
      title: `平掉 ${lot.direction === 'LONG' ? '多' : '空'}仓`,
      content: (
        <div className="text-[12px] leading-relaxed">
          <div>交易对：{lot.symbol}　方向：{lot.direction === 'LONG' ? '做多' : '做空'}</div>
          <div>
            数量：<span className="num">{qty.toFixed(6)}</span>　开仓价：
            <span className="num">{formatPrice(entry)}</span>
          </div>
          <div className="mt-1 text-muted">市价单，成交后该 Lot 全量了结并结算盈亏。</div>
        </div>
      ),
      okText: '确认平仓',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        requireAuth(async () => {
          setClosingLotId(lot.id);
          try {
            await place.mutateAsync({
              action: lot.direction === 'LONG' ? 'SELL' : 'BUY',
              symbol: lot.symbol,
              lotId: lot.id,
            });
            message.success(`已提交平仓：${lot.symbol} ${qty.toFixed(4)} ${lot.direction}`);
          } catch (err) {
            message.error((err as Error).message);
          } finally {
            setClosingLotId(null);
          }
        }),
    });
  };

  const saveEnabled = (checked: boolean) => {
    update.mutate({ enabled: checked }, { onError: (e) => message.error(e.message) });
  };

  const savePatch = (patch: Record<string, unknown>) => {
    update.mutate(patch, { onError: (e) => message.error(e.message) });
  };

  /**
   * 切换运行模式。
   *
   * `live` 使用真实资金、且挂载的策略会自动下单，因此必须二次确认。
   * 这是**防误操作**（不是平台风控）：平台不拦截任何交易，只在这里把
   * 「你正在进入实盘」讲清楚，避免误点。
   */
  const onModeChange = (next: string) => {
    if (next !== 'live') {
      savePatch({ mode: next });
      return;
    }
    modal.confirm({
      title: '切换到实盘（真实资金）',
      icon: <ExclamationCircleOutlined className="text-down" />,
      width: 520,
      content: (
        <div className="space-y-2 text-[12px] leading-relaxed">
          <div>
            实盘模式下，<b>挂载的策略会用真实资金自动下单</b>，平台不做任何风控拦截。
          </div>
          <div>切换前请确认：</div>
          <ul className="list-disc pl-5">
            <li>该策略已在测试网充分验证</li>
            <li>测试网仓位已全部平掉</li>
            <li>清楚止损、强平与爆仓风险</li>
          </ul>
        </div>
      ),
      okText: '我确认，切换到实盘',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => savePatch({ mode: 'live' }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ThunderboltOutlined className="text-btc" />
          <span className="text-[15px] font-semibold">币安合约面板</span>
          <Tag color={cfg?.enabled ? 'green' : 'default'}>{cfg?.enabled ? '运行中' : '已停止'}</Tag>
        </div>
        <Space>
          <Switch checked={cfg?.enabled} onChange={saveEnabled} checkedChildren="启用" unCheckedChildren="停用" />
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
          <div className="text-[11px] text-muted">平台不设上限，由策略决定</div>
        </Card>
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">保证金模式</div>
          <div className="num text-[20px] font-semibold text-white">
            {cfg?.marginType === 'isolated' ? '逐仓' : '全仓'}
          </div>
          <div className="text-[11px] text-muted">逐仓单仓风险隔离</div>
        </Card>
        <Card size="small" className="glass-card">
          <div className="text-[12px] text-muted">未完结仓位单</div>
          <div className="num text-[20px] font-semibold text-white">{futuresLots.length}</div>
          <div className="text-[11px] text-muted">每单独立了结</div>
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
        extra={
          <span className="text-[11px] text-muted">
            与上方交易所净持仓对照 · 出场由策略负责（平台不设逐层止盈止损）
          </span>
        }
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
            {
              title: '操作', key: 'action', width: 90,
              render: (_, row) =>
                row.status !== 'OPEN' ? null : (
                  <Button
                    size="small"
                    danger
                    loading={closingLotId === row.id || place.isPending}
                    disabled={closingLotId !== null}
                    onClick={() => closeLot(row)}
                  >
                    平仓
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      <Card title="交易参数" className="glass-card" size="small">
        <Row gutter={24}>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">运行模式</div>
            <Select
              value={cfg?.mode ?? 'dry_run'}
              style={{ width: '100%' }}
              options={[
                { label: 'dry_run（本地模拟，不触交易所）', value: 'dry_run' },
                { label: 'testnet（币安测试网）', value: 'testnet' },
                { label: 'live（实盘 · 真实资金）', value: 'live' },
              ]}
              onChange={onModeChange}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">开仓杠杆（1 ~ 20x）</div>
            <Slider
              min={1}
              max={20}
              step={1}
              value={cfg?.leverage ?? 5}
              onChange={(v) => savePatch({ leverage: v })}
              marks={{ 1: '1x', 5: '5x', 20: '20x' }}
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
        </Row>


        <div className="mt-3 text-[11px] text-muted">
          策略参数请在「策略管理」页按策略单独配置 · 最后运行 {formatTime(cfg?.lastRunAt)}
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
