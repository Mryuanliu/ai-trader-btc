import { useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { ExclamationCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useSetStrategyEnabled, useStrategies } from '@/api/hooks';
import { formatTime } from '@/utils/format';
import type { GateVerdict, StrategyDescriptor } from '@ai-trader/shared';

/**
 * 策略上架治理（闸门闭环操作页）。
 *
 * 列出**全部**策略（含未上架），每条展示上架状态与上次闸门快照，
 * 并提供上/下架开关。上架会触发后端三判据闸门：
 * - 达标 → 放行、写回 backtestRef 留痕；
 * - 未达 → 拦下并弹出未达原因，需填写理由强推（forceOverride，落库 overrideReason）。
 *
 * 与面向浏览的「策略管理」卡片页解耦：这里只做运营动作（上下架 + 闸门）。
 */

/** 闸门三判据阈值（与后端 backtest.service 常量保持一致，仅用于展示标红） */
const GATE_DSR_MIN = 0.5;
const GATE_OOS_SHARPE_MIN = 0;
const GATE_OOS_MAX_DD_PCT = 10;

export function AdminStrategyGovernance() {
  const navigate = useNavigate();
  const strategies = useStrategies(true);
  const setEnabled = useSetStrategyEnabled();
  const { message, modal } = AntApp.useApp();

  /** 被闸门拦下、等待用户填写 override 理由的上下文 */
  const [gateCtx, setGateCtx] = useState<{ name: string; label: string; gate: GateVerdict } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const rows = strategies.data ?? [];

  /** 上架：调用闸门；未达时不抛错而是拿到 gated 结果弹 override 框 */
  const tryEnable = async (s: StrategyDescriptor, forceReason?: string) => {
    setSubmitting(true);
    try {
      const r = await setEnabled.mutateAsync({
        name: s.name,
        enabled: true,
        forceOverrideReason: forceReason,
      });
      if (r.ok) {
        message.success(forceReason ? `已强制上架「${s.label}」并留痕` : `已上架「${s.label}」`);
        setGateCtx(null);
        setReason('');
        return;
      }
      if (r.gated && r.gate) {
        // 正常上架被拦：弹出未达详情；带理由重推时若仍返回 gated（理论不会）也走这里
        setGateCtx({ name: s.name, label: s.label, gate: r.gate });
        message.warning('闸门未达，未上架');
        return;
      }
      message.error(r.message || '上架失败');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 下架：无闸门，二次确认后直接执行 */
  const doDisable = (s: StrategyDescriptor) => {
    modal.confirm({
      title: `下架「${s.label}」？`,
      icon: <ExclamationCircleOutlined className="text-down" />,
      content: (
        <div className="text-[12px] leading-relaxed">
          下架后该策略将从策略市场移除，且不能再被启动实盘。已运行的实例不受影响，需另行停止。
        </div>
      ),
      okText: '确认下架',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await setEnabled.mutateAsync({ name: s.name, enabled: false });
          if (r.ok) message.success(`已下架「${s.label}」`);
          else message.error(r.message || '下架失败');
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const onToggle = (s: StrategyDescriptor, next: boolean) => {
    if (next) void tryEnable(s);
    else doDisable(s);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-semibold text-white">
            <SafetyCertificateOutlined className="text-btc" />
            策略上架治理
          </h2>
          <div className="muted-text mt-0.5">
            上架前经回测闸门把关（sweep DSR ≥ {GATE_DSR_MIN} · OOS Sharpe &gt; {GATE_OOS_SHARPE_MIN} ·
            OOS 回撤 &lt; {GATE_OOS_MAX_DD_PCT}%）；未达标需填写理由强推并留痕
          </div>
        </div>
        <Space>
          <Button onClick={() => void strategies.refetch()} loading={strategies.isFetching}>
            刷新
          </Button>
        </Space>
      </div>

      <Card className="!border-white/[0.06] !bg-white/[0.02]">
        {strategies.isLoading ? (
          '加载中…'
        ) : rows.length === 0 ? (
          <Empty description="暂无策略包（检查 strategies/ 目录与实现注册）" />
        ) : (
          <Table<StrategyDescriptor>
            rowKey="name"
            dataSource={rows}
            pagination={false}
            columns={[
              {
                title: '策略',
                dataIndex: 'label',
                render: (_v, s) => (
                  <div className="space-y-0.5">
                    <div className="text-white">{s.label}</div>
                    <div className="muted-text text-[12px]">{s.name}</div>
                  </div>
                ),
              },
              {
                title: '上架状态',
                dataIndex: 'enabled',
                width: 110,
                render: (_v, s) =>
                  s.enabled ? (
                    <Tag color="green" className="!mr-0">已上架</Tag>
                  ) : (
                    <Tag className="!mr-0">未上架</Tag>
                  ),
              },
              {
                title: '上次闸门快照',
                dataIndex: 'backtestRef',
                render: (_v, s) => {
                  const ref = s.backtestRef;
                  if (!ref) return <span className="muted-text">未记录</span>;
                  const overridden = ref.verdict === 'overfit';
                  return (
                    <div className="space-y-0.5 text-[12px]">
                      <div className="flex items-center gap-2">
                        <Tag color={overridden ? 'red' : 'green'} className="!mr-0">
                          {overridden ? '人工放行' : '达标放行'}
                        </Tag>
                        <span className="muted-text">DSR {ref.dsr?.toFixed(3) ?? '—'}</span>
                        <span className="muted-text">{formatTime(ref.ts)}</span>
                      </div>
                      {overridden && ref.overrideReason && (
                        <Tooltip title={ref.overrideReason}>
                          <div className="max-w-[360px] truncate text-down">
                            理由：{ref.overrideReason}
                          </div>
                        </Tooltip>
                      )}
                    </div>
                  );
                },
              },
              {
                title: '操作',
                key: 'action',
                width: 120,
                render: (_v, s) => (
                  <Switch
                    checked={!!s.enabled}
                    loading={setEnabled.isPending && setEnabled.variables?.name === s.name}
                    onChange={(next) => onToggle(s, next)}
                  />
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 闸门未达 → override 弹窗 */}
      <Modal
        open={!!gateCtx}
        title={<span className="text-down">闸门未达：无法直接上架</span>}
        onCancel={() => {
          setGateCtx(null);
          setReason('');
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setGateCtx(null);
              setReason('');
            }}
          >
            取消
          </Button>,
          <Button
            key="override"
            danger
            type="primary"
            disabled={!reason.trim() || submitting}
            loading={submitting}
            onClick={() => {
              if (!gateCtx) return;
              const s = rows.find((x) => x.name === gateCtx.name);
              if (!s) return;
              void tryEnable(s, reason.trim());
            }}
          >
            仍要上架（留痕）
          </Button>,
        ]}
      >
        {gateCtx && (
          <div className="space-y-4">
            <Alert
              type="error"
              showIcon
              message="未通过的回测判据"
              description={
                <ul className="m-0 list-disc pl-5 text-[12px]">
                  {(gateCtx.gate.reasons.length ? gateCtx.gate.reasons : ['闸门未通过']).map(
                    (x) => (
                      <li key={x}>{x}</li>
                    ),
                  )}
                </ul>
              }
            />

            <div className="grid grid-cols-3 gap-3">
              <GateStat
                label="sweep DSR"
                value={gateCtx.gate.dsr}
                fmt={(v) => v.toFixed(3)}
                pass={gateCtx.gate.dsr != null && gateCtx.gate.dsr >= GATE_DSR_MIN}
                hint={`≥ ${GATE_DSR_MIN}`}
              />
              <GateStat
                label="OOS Sharpe"
                value={gateCtx.gate.oosSharpe}
                fmt={(v) => v.toFixed(2)}
                pass={gateCtx.gate.oosSharpe != null && gateCtx.gate.oosSharpe > GATE_OOS_SHARPE_MIN}
                hint={`> ${GATE_OOS_SHARPE_MIN}`}
              />
              <GateStat
                label="OOS 回撤 (%)"
                value={gateCtx.gate.oosMaxDD}
                fmt={(v) => v.toFixed(2)}
                pass={gateCtx.gate.oosMaxDD != null && gateCtx.gate.oosMaxDD < GATE_OOS_MAX_DD_PCT}
                hint={`< ${GATE_OOS_MAX_DD_PCT}`}
              />
            </div>

            <div className="muted-text text-[12px]">
              建议先到「回测台」为该策略运行
              <a
                className="mx-1 text-btc"
                onClick={() =>
                  navigate(`/admin/backtest?strategy=${encodeURIComponent(gateCtx.name)}`)
                }
              >
                research / sweep
              </a>
              取得达标记录后再上架。
            </div>

            <div>
              <div className="mb-1 text-[12px] text-white">坚持上架理由（必填，将写入清单留痕）</div>
              <Input.TextArea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：内部小额试验，已知 DSR 未达，限 0.5% 风险敞口观察 2 周"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** 闸门单项判据展示：达标绿、未达红、缺数据灰 */
function GateStat({
  label,
  value,
  fmt,
  pass,
  hint,
}: {
  label: string;
  value?: number;
  fmt: (v: number) => string;
  pass: boolean;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="muted-text text-[12px]">{label}</div>
      <div className={`mt-1 text-[16px] font-semibold ${value == null ? 'text-subtle' : pass ? 'text-up' : 'text-down'}`}>
        {value == null ? '无数据' : fmt(value)}
      </div>
      <div className="muted-text mt-0.5 text-[11px]">要求 {hint}</div>
    </div>
  );
}
