import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Table,
  Tag,
} from 'antd';
import { DollarOutlined, PoweroffOutlined } from '@ant-design/icons';
import type { BasketSummary } from '@ai-trader/shared';
import {
  useCloseBasket,
  useStrategies,
  useStrategyStatus,
  useStopStrategy,
} from '@/api/hooks';
import { useRequireAuth } from '@/components/AuthGate';
import { DevDocsButton } from '@/components/DevDocsDrawer';
import { SideTag } from '@/components/OrderStatusTag';
import { formatPrice, formatQty, formatSignedUsd, formatTime } from '@/utils/format';
import { LeaderboardCard } from './LeaderboardCard';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num mt-0.5 text-[15px] text-white">{value}</div>
    </div>
  );
}

/**
 * 策略详情页（二级页面）。
 *
 * 信息架构：列表页只回答「有哪些策略」，本页回答「这个策略现在怎么样、表现如何」。
 * 运行状态与绩效都是**高频变化或需要横向对比**的信息，塞进列表页会让首页变成仪表盘，
 * 既乱又挡住「选策略」这个主任务。所以按递进关系收到二级页。
 */
export function AdminStrategyDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const strategies = useStrategies();
  const status = useStrategyStatus();
  const stop = useStopStrategy();
  const closeBasket = useCloseBasket();
  const { message, modal } = AntApp.useApp();
  const { run: requireAuth } = useRequireAuth();
  const [stopping, setStopping] = useState(false);

  const strategy = (strategies.data ?? []).find((s) => s.name === name);
  const st = status.data;
  // 运行状态接口只给「第一个实例」，因此这里必须比对策略名：
  // 跑着别的策略时不能把它的状态显示在本页
  const isThisRunning = !!st?.running && st.name === name;

  const s = (st?.state ?? {}) as Record<string, unknown>;
  const numOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const layers = (s.layers ?? {}) as Record<string, number>;
  const pending = (s.pending ?? {}) as Record<string, number>;
  const nextAdd = (s.nextAdd ?? {}) as Record<string, number | null>;
  const ladder = (s.ladder ?? null) as
    | {
        long?: Array<{ layer: number; price: number; qty: number }>;
        short?: Array<{ layer: number; price: number; qty: number }>;
      }
    | null;
  const maxLayers = numOf(s.maxLayers) ?? 6;
  const netPct = numOf(s.netPct);
  const startPct = numOf(s.basketStartPct);
  const price = numOf(s.price);
  const step = numOf(s.step);
  const leverage = numOf(s.leverage);

  const tickAgoSec = st?.lastTickAt
    ? Math.max(0, Math.round((Date.now() - new Date(st.lastTickAt).getTime()) / 1000))
    : null;
  const tickStale = tickAgoSec !== null && tickAgoSec > 30;

  /** 把状态翻译成「它在等什么」（马丁网格大部分时间在等待，不说清会被当成卡死） */
  const waiting = (() => {
    const parts: string[] = [];
    const pL = pending.long ?? 0;
    const pS = pending.short ?? 0;
    if (pL + pS > 0) parts.push(`已挂 ${pL + pS} 张 STOP 单，等价格触发`);
    if (nextAdd.long != null && (layers.long ?? 0) > 0) {
      parts.push(`多头加层需跌破 ${formatPrice(nextAdd.long)}`);
    }
    if (nextAdd.short != null && (layers.short ?? 0) > 0) {
      parts.push(`空头加层需涨破 ${formatPrice(nextAdd.short)}`);
    }
    if (netPct != null && startPct != null && startPct > 0 && netPct < startPct) {
      parts.push(
        `止盈需净收益达 ${(startPct * 100).toFixed(2)}%（当前 ${(netPct * 100).toFixed(2)}%）`,
      );
    }
    return parts.join(' · ');
  })();

  const doStop = () =>
    requireAuth(async () => {
      setStopping(true);
      try {
        await stop.mutateAsync();
        message.success('策略已停止。已有持仓不会被自动平掉，请到合约面板手动处理。');
      } catch (err) {
        message.error((err as Error).message);
      } finally {
        setStopping(false);
      }
    });

  const doCloseBasket = () =>
    requireAuth(() => {
      modal.confirm({
        title: '一键平仓（了结当前这一轮）',
        icon: <DollarOutlined className="text-down" />,
        width: 460,
        okText: '确认平仓',
        okButtonProps: { danger: true },
        cancelText: '取消',
        content: (
          <div className="space-y-1.5 text-[12px] leading-relaxed">
            <div>
              将平掉当前篮子的 <b>{st?.openLotCount ?? 0}</b> 个仓位单，并撤销全部未成交挂单。
            </div>
            <div>
              平仓后策略<b>继续运行</b>，下一轮挂单会自动开始。
            </div>
          </div>
        ),
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

  if (strategies.isLoading) {
    return <Card className="!border-white/[0.06] !bg-white/[0.02]">加载中…</Card>;
  }
  if (!strategy) {
    return (
      <Card className="!border-white/[0.06] !bg-white/[0.02]">
        <Empty description={`未找到策略「${name}」`} />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* 页头：返回 + 标题 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button type="text" onClick={() => navigate('/admin/strategy')}>
            ← 返回
          </Button>
          <div>
            <h2 className="text-[17px] font-semibold text-white">{strategy.label}</h2>
            <div className="muted-text mt-0.5">
              {strategy.description}
            </div>
          </div>
        </div>
        <Space>
          <DevDocsButton />
          {isThisRunning ? (
            <>
              <Tag color="processing" className="!mr-0">
                运行中
              </Tag>
              <Button
                icon={<DollarOutlined />}
                loading={closeBasket.isPending}
                onClick={doCloseBasket}
              >
                一键平仓
              </Button>
              <Button
                danger
                icon={<PoweroffOutlined />}
                loading={stopping}
                onClick={doStop}
              >
                停止策略
              </Button>
            </>
          ) : (
            <Tag className="!mr-0">未运行</Tag>
          )}
        </Space>
      </div>

      {/* 运行状态 */}
      {isThisRunning && st ? (
        <Card size="small" title="运行状态" className="!border-white/[0.06] !bg-white/[0.02]">
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Stat label="未完结仓位单" value={String(st.openLotCount)} />
            </Col>
            <Col xs={12} md={6}>
              <Stat label="启动时间" value={st.startedAt ? formatTime(st.startedAt) : '--'} />
            </Col>
            <Col xs={12} md={6}>
              <Stat
                label="最近 tick（心跳）"
                value={tickAgoSec === null ? '--' : `${tickAgoSec} 秒前`}
              />
            </Col>
            <Col xs={12} md={6}>
              <Stat
                label="篮子净收益率"
                value={netPct != null ? `${(netPct * 100).toFixed(2)}%` : '--'}
              />
            </Col>
          </Row>

          {/* 网格进度：回答「为什么现在不动」 */}
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3 text-[12px] sm:grid-cols-4">
            <div>
              <span className="text-muted">多头层数 </span>
              <span className="num text-white">
                {layers.long ?? 0}/{maxLayers}
              </span>
              {pending.long ? <span className="text-muted">（{pending.long} 单待触发）</span> : null}
            </div>
            <div>
              <span className="text-muted">空头层数 </span>
              <span className="num text-white">
                {layers.short ?? 0}/{maxLayers}
              </span>
              {pending.short ? (
                <span className="text-muted">（{pending.short} 单待触发）</span>
              ) : null}
            </div>
            <div>
              <span className="text-muted">当前价 </span>
              <span className="num text-white">{price != null ? formatPrice(price) : '--'}</span>
              {step != null ? <span className="text-muted"> · 网格 {step.toFixed(1)}</span> : null}
            </div>
            <div>
              <span className="text-muted">杠杆 </span>
              <span className="num text-white">{leverage != null ? `${leverage}x` : '--'}</span>
            </div>
          </div>

          {/* 阶梯预览：逐格推进只能挂一层，摊开才看得出间距是否合理 */}
          {ladder ? (
            <div className="mt-3 grid grid-cols-1 gap-4 border-t border-white/[0.06] pt-3 sm:grid-cols-2">
              {(['long', 'short'] as const).map((sideKey) => {
                const rows = ladder[sideKey] ?? [];
                if (rows.length === 0) return null;
                const filledN = (sideKey === 'long' ? layers.long : layers.short) ?? 0;
                return (
                  <div key={sideKey}>
                    <div className="mb-1 text-[12px] text-muted">
                      {sideKey === 'long' ? '多头阶梯（越跌越买）' : '空头阶梯（越涨越卖）'}
                      <span className="text-subtle"> · 模型推演，实际成交见下方篮子</span>
                    </div>
                    <div className="space-y-[3px]">
                      {rows.map((r) => {
                        const done = r.layer <= filledN;
                        return (
                          <div
                            key={r.layer}
                            className="flex items-center justify-between text-[11px]"
                          >
                            <span className={done ? 'text-up' : 'text-subtle'}>
                              L{r.layer} {done ? '已成交' : '待触发'}
                            </span>
                            <span className={`num ${done ? 'text-up' : 'text-white'}`}>
                              {formatPrice(r.price)}
                            </span>
                            <span className="num text-subtle">{r.qty}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-1.5 text-[11px]">
            <span className={tickStale ? 'text-down' : 'text-up'}>●</span>
            <span className={tickStale ? 'text-down' : 'text-subtle'}>
              {tickAgoSec === null
                ? '尚未产生心跳'
                : tickStale
                  ? `心跳已停 ${tickAgoSec} 秒 —— 策略可能卡死，请查看错误信息`
                  : `心跳正常（${tickAgoSec} 秒前），策略每 5 秒决策一次`}
            </span>
          </div>

          {waiting ? (
            <div className="mt-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-subtle">
              等待中：{waiting}
            </div>
          ) : null}

          {typeof s.note === 'string' && s.note ? (
            <div className="mt-2 text-[12px] text-subtle">
              <span className="muted-text">最近动作：</span>
              {s.note}
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
      ) : (
        <Card size="small" className="!border-white/[0.06] !bg-white/[0.02]">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="text-[12px] text-muted">
                该策略当前未运行 —— 返回列表页点「启动」后，这里会显示实时状态与阶梯
              </span>
            }
          />
        </Card>
      )}

      {/* 当前篮子：一篮子 = 会被一起平掉的一轮订单（类似 EA 魔术号分组）。
          阶梯是模型推演，这里是**实际成交**的持仓明细，两者分开看。 */}
      {isThisRunning && st?.baskets && st.baskets.length > 0 ? (
        <Card
          size="small"
          title="当前篮子"
          className="!border-white/[0.06] !bg-white/[0.02]"
          extra={
            <span className="text-[11px] text-muted">
              同一篮子的订单在篮子止盈/止损/一键平仓时一起了结
            </span>
          }
        >
          {st.baskets.map((basket) => {
            const totalPnl = basket.realizedPnl + basket.unrealizedPnl;
            return (
              <div key={basket.id} className="mb-3 last:mb-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="num font-medium text-white">{basket.code}</span>
                  <Tag
                    color={basket.direction === 'LONG' ? 'green' : basket.direction === 'SHORT' ? 'red' : 'gold'}
                    className="!mr-0"
                  >
                    {basket.direction === 'LONG' ? '买入' : basket.direction === 'SHORT' ? '卖出' : '双向'}
                  </Tag>
                  <span className="text-muted">
                    {basket.layerCount} 层 · 均价 <span className="num">{formatPrice(basket.avgEntryPrice)}</span>
                  </span>
                  <span className="text-muted">
                    整体盈亏{' '}
                    <span className={`num ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
                      {formatSignedUsd(totalPnl)}
                    </span>
                    {basket.returnPct != null ? (
                      <span className={totalPnl >= 0 ? 'text-up' : 'text-down'}>
                        {' '}（{(basket.returnPct * 100).toFixed(2)}%）
                      </span>
                    ) : null}
                  </span>
                </div>
                <Table<BasketSummary['lots'][number]>
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={basket.lots}
                  locale={{
                    emptyText: <span className="text-[12px] text-muted">该篮子暂无仓位单</span>,
                  }}
                  columns={[
                    {
                      title: '层',
                      dataIndex: 'layer',
                      width: 46,
                      render: (v: number) => <span className="num text-muted">L{v}</span>,
                    },
                    {
                      title: '方向',
                      dataIndex: 'direction',
                      render: (v: string) => <SideTag side={v === 'LONG' ? 'BUY' : 'SELL'} />,
                    },
                    {
                      title: '数量',
                      dataIndex: 'quantity',
                      align: 'right',
                      render: (v: number) => <span className="num">{formatQty(v)}</span>,
                    },
                    {
                      title: '开仓价',
                      dataIndex: 'entryPrice',
                      align: 'right',
                      render: (v: number) => <span className="num">{formatPrice(v)}</span>,
                    },
                    {
                      title: '层盈亏',
                      dataIndex: 'realizedPnl',
                      align: 'right',
                      render: (v: number | null) =>
                        v === null ? (
                          <span className="text-[11px] text-muted">持仓中</span>
                        ) : (
                          <span className={`num ${v >= 0 ? 'text-up' : 'text-down'}`}>
                            {formatSignedUsd(v)}
                          </span>
                        ),
                    },
                    {
                      title: '开仓时间',
                      dataIndex: 'openedAt',
                      render: (v: string) => (
                        <span className="text-[11px] text-muted">{formatTime(v)}</span>
                      ),
                    },
                  ]}
                />
              </div>
            );
          })}
        </Card>
      ) : null}

      {/* 参数：只读展示当前生效参数（修改走列表页的「参数配置」） */}
      <Card size="small" title="当前参数" className="!border-white/[0.06] !bg-white/[0.02]">
        <Row gutter={[12, 8]}>
          {Object.entries(strategy.defaultParams).map(([k, v]) => (
            <Col xs={12} md={6} key={k}>
              <div className="text-[11px] text-muted">{k}</div>
              <div className="num text-[13px] text-white">{String(v)}</div>
            </Col>
          ))}
        </Row>
        <div className="mt-2 text-[11px] text-muted">
          调整参数请返回列表页，在策略卡片上点「参数配置」后启动
        </div>
      </Card>

      {/* 绩效：排行榜收纳到二级页，按策略过滤 */}
      <LeaderboardCard strategyName={name} />
    </div>
  );
}
