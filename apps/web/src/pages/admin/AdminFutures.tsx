import { useState } from 'react';
import { App as AntApp, Button, Card, Col, InputNumber, Row, Select, Slider, Space, Switch, Table, Tag, Tooltip } from 'antd';
import { ExclamationCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  useFuturesConfig,
  useFuturesMargin,
  useFuturesPlaceOrder,
  useFuturesPositions,
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
  const { message, modal } = AntApp.useApp();
  const { run: requireAuth } = useRequireAuth();
  /** 正在平仓的 Lot（用于按钮 loading 态） */

  const cfg = config.data;

  const saveEnabled = (checked: boolean) => {
    update.mutate({ enabled: checked }, { onError: (e) => message.error(e.message) });
  };

  /**
   * 交易参数的本地草稿。
   *
   * 杠杆/保证金这类参数改错代价高，所以不走「拖动即保存」——
   * 先改草稿，点「确定」才落库。`null` 表示「未编辑，显示服务端值」。
   */
  const [draft, setDraft] = useState<{
    mode: string;
    leverage: number;
    positionPct: number;
  } | null>(null);

  const cur = {
    mode: draft?.mode ?? cfg?.mode ?? 'dry_run',
    leverage: draft?.leverage ?? cfg?.leverage ?? 5,
    positionPct: draft?.positionPct ?? cfg?.positionPct ?? 0.1,
  };

  /** 是否存在未保存的改动 */
  const dirty =
    !!cfg &&
    (cur.mode !== cfg.mode ||
      cur.leverage !== cfg.leverage ||
      Math.abs(cur.positionPct - cfg.positionPct) > 1e-9);

  /**
   * 保存交易参数（点「确定」才走这里）。
   *
   * `live` 使用真实资金、且挂载的策略会自动下单，因此提交前二次确认。
   * 这是**防误操作**（不是平台风控）：平台不拦截任何交易，
   * 只在这里把「你正在进入实盘」讲清楚，避免误点。
   */
  const saveTradeParams = () => {
    if (!cfg || !dirty) return;

    // 只提交真正变化的字段，避免把未动的参数重写一遍
    const patch: Record<string, unknown> = {};
    if (cur.mode !== cfg.mode) patch.mode = cur.mode;
    if (cur.leverage !== cfg.leverage) patch.leverage = cur.leverage;
    if (Math.abs(cur.positionPct - cfg.positionPct) > 1e-9) {
      patch.positionPct = cur.positionPct;
    }
    if (Object.keys(patch).length === 0) return;

    const commit = async () => {
      try {
        await update.mutateAsync(patch);
        // 保存成功后交给服务端值接管显示，避免本地草稿与后端长期不一致
        setDraft(null);
        message.success('交易参数已保存');
      } catch (err) {
        message.error((err as Error).message);
      }
    };

    if (patch.mode === 'live') {
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
        onOk: commit,
      });
      return;
    }
    void commit();
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
        title="交易参数"
        className="glass-card"
        size="small"
        extra={
          <Space>
            <Button size="small" disabled={!dirty} onClick={() => setDraft(null)}>
              重置
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!dirty}
              loading={update.isPending}
              onClick={saveTradeParams}
            >
              确定
            </Button>
          </Space>
        }
      >
        <Row gutter={24}>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">运行模式</div>
            <Select
              value={cur.mode}
              style={{ width: '100%' }}
              options={[
                { label: 'dry_run（本地模拟，不触交易所）', value: 'dry_run' },
                { label: 'testnet（币安测试网）', value: 'testnet' },
                { label: 'live（实盘 · 真实资金）', value: 'live' },
              ]}
              onChange={(v) => setDraft({ ...cur, mode: v })}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">
              开仓杠杆（1 ~ 20x）　
              <span className="num text-white">{cur.leverage}x</span>
            </div>
            <Slider
              min={1}
              max={20}
              step={1}
              value={cur.leverage}
              onChange={(v) => setDraft({ ...cur, leverage: v })}
              marks={{ 1: '1x', 5: '5x', 10: '10x', 20: '20x' }}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="mb-1 text-[12px] text-muted">
              保证金占用比例（positionPct）　
              <span className="num text-white">{(cur.positionPct * 100).toFixed(0)}%</span>
            </div>
            <Slider
              min={0.01}
              max={1}
              step={0.01}
              value={cur.positionPct}
              onChange={(v) => setDraft({ ...cur, positionPct: v })}
            />
          </Col>
        </Row>

        {dirty ? (
          <div className="mt-2 text-[11px] text-up">
            有未保存的修改 —— 点右上角「确定」后生效
          </div>
        ) : null}

        <div className="mt-3 text-[11px] text-muted">
          策略参数请在「策略管理」页按策略单独配置 · 最后运行 {formatTime(cfg?.lastRunAt)}
        </div>
      </Card>
    </div>
  );
}

