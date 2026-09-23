import { useState } from 'react';
import { Segmented, Skeleton, Table, Tag, Tooltip } from 'antd';
import clsx from 'clsx';
import { Activity, Flame, Gauge, HelpCircle, Wallet } from 'lucide-react';
import {
  MARKET_LABELS,
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  type BasketSummary,
  type OrderStatus,
  type Timeframe,
} from '@ai-trader/shared';
import { useCandles, useMarketPulse, useOpenLots, useOverview } from '@/api/hooks';
import { KlineChart } from '@/components/KlineChart';
import { StatCard } from '@/components/StatCard';
import { OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { KeywordBars } from '@/components/Sparkline';
import { EnvBadge, LivePulse } from '@/components/StatusBits';
import {
  formatPct,
  formatPrice,
  formatQty,
  formatSignedUsd,
  formatTime,
  formatUsd,

  trendClass,
} from '@/utils/format';

/** 服务端返回 0 表示「取不到真实值」时统一降级为 --，避免把缺失画成 0 */
function orDash(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return undefined;
  }
  return value;
}

/** 带问号图标的口径说明，hover 展示计算方式与数据来源 */
function InfoHint({ text }: { text: React.ReactNode }) {
  return (
    <Tooltip title={text} overlayStyle={{ maxWidth: 380 }}>
      <HelpCircle size={12} className="cursor-help text-muted transition-colors hover:text-btc-light" />
    </Tooltip>
  );
}

export function AdminOverview() {
  const { data, isLoading } = useOverview();
  const [interval, setInterval] = useState<Timeframe>('5m');
  const { data: candles = [] } = useCandles('BTCUSDT', interval, 300);
  const { data: pulse } = useMarketPulse('BTCUSDT');
  // 当前未完结仓位单（Lot）：每笔独立止盈止损，全量平掉才完结（仅合约）
  const { data: openLots = [] } = useOpenLots({ market: 'futures', symbol: 'BTCUSDT' });

  if (isLoading && !data) {
    return <Skeleton active paragraph={{ rows: 10 }} />;
  }

  const totals = data?.totals;
  const hasPnl = totals?.hasPnlBaseline ?? false;
  const pnlToday = hasPnl ? totals?.pnlToday ?? 0 : undefined;
  const realized = hasPnl ? totals?.realizedPnlToday ?? 0 : undefined;
  const unrealized = hasPnl ? totals?.unrealizedPnlToday ?? 0 : undefined;

  const tickerOk = (data?.ticker?.price ?? 0) > 0;
  const hasBalances = (data?.balances?.length ?? 0) > 0;

  const sentimentText =
    pulse?.sentiment === 'bullish' ? '偏强' : pulse?.sentiment === 'bearish' ? '偏弱' : '震荡';

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部指标条 */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="BTC / USDT"
          value={`${formatPrice(orDash(data?.ticker?.price))}`}
          tone="btc"
          icon={<Activity size={15} />}
          hint={
            tickerOk ? (
              <span className={(data?.ticker?.changePercent24h ?? 0) >= 0 ? 'text-up' : 'text-down'}>
                24h {formatPct(data?.ticker?.changePercent24h)} · 高{' '}
                {formatPrice(orDash(data?.ticker?.high24h))} / 低{' '}
                {formatPrice(orDash(data?.ticker?.low24h))}
              </span>
            ) : (
              <span>行情未就绪，暂无报价</span>
            )
          }
        />
        <StatCard
          label="账户总估值"
          value={
            hasBalances ? (
              `${formatUsd(totals?.usdtValue ?? 0)} USDT`
            ) : (
              <span className="text-muted">--</span>
            )
          }
          icon={<Wallet size={15} />}
          hint={
            hasBalances ? (
              <>
                合约未平 {totals?.openOrders ?? 0} 单 · 今日成交 {totals?.filledToday ?? 0} 笔
                {totals?.btcAmount ? ` · 现货余额 ${formatQty(totals.btcAmount)} BTC` : ''}
              </>
            ) : (
              '未读取到账户余额'
            )
          }
        />
        <StatCard
          label="今日盈亏"
          value={
            <span className={pnlToday === undefined ? 'text-muted' : trendClass(pnlToday)}>
              {formatSignedUsd(pnlToday)} USDT
            </span>
          }
          tone={pnlToday === undefined ? 'default' : pnlToday >= 0 ? 'up' : 'down'}
          icon={<Gauge size={15} />}
          hint={
            <span className="inline-flex items-center gap-1">
              {hasPnl ? (
                <>
                  已实现{' '}
                  <span className={trendClass(realized)}>{formatSignedUsd(realized)}</span> · 浮动{' '}
                  <span className={trendClass(unrealized)}>{formatSignedUsd(unrealized)}</span>
                </>
              ) : (
                '暂无成交与持仓'
              )}
              <InfoHint
                text={
                  <div className="text-[11px] leading-relaxed">
                    <div className="mb-1 font-medium">今日盈亏 = 已实现 + 浮动</div>
                    <div>· 已实现：今日 00:00 后平仓/售出回合的净盈亏之和，已扣手续费</div>
                    <div>· 浮动：现货 (现价 − 含费成本均价) × 持仓量 ＋ 合约交易所 unrealizedProfit</div>
                    <div className="mt-1 text-white/60">
                      口径与订单页「回合盈亏」同源；既无成交又无持仓时显示 --
                    </div>
                  </div>
                }
              />
            </span>
          }
        />
        <StatCard
          label="市场情绪"
          value={pulse ? sentimentText : <span className="text-muted">--</span>}
          tone={
            pulse?.sentiment === 'bullish' ? 'up' : pulse?.sentiment === 'bearish' ? 'down' : 'default'
          }
          icon={<Flame size={15} />}
          hint={
            <span className="inline-flex items-center gap-1">
              {pulse ? (
                `分值 ${pulse.sentimentScore.toFixed(0)} · 量能 ${pulse.volumeRatio.toFixed(2)}x`
              ) : (
                '行情数据不足'
              )}
              <InfoHint text={<SentimentFormula />} />
            </span>
          }
        />
      </section>

      {/* K 线 + 市场动向 */}
      <section className="grid gap-4 xl:grid-cols-3">
        <div className="glass-card p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className="section-title">BTC / USDT 走势</span>
              <span className="num text-[12px] text-muted">{data?.ticker.symbol}</span>
              {data ? <EnvBadge mode={data.mode} /> : null}
            </div>
            <Segmented
              size="small"
              value={interval}
              onChange={(v) => setInterval(v as Timeframe)}
              options={TIMEFRAMES.map((tf) => ({ label: TIMEFRAME_LABELS[tf], value: tf }))}
            />
          </div>
          <KlineChart candles={candles} height={340} resetKey={interval} />
        </div>

        <div className="glass-card p-4">
          <div className="flex items-center gap-1.5">
            <span className="section-title">今日市场动向</span>
            <InfoHint text={<PulseFormula />} />
          </div>
          {pulse ? (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-subtle">{pulse.summary}</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat
                  label="24h 涨跌"
                  value={formatPct(pulse.changePercent24h)}
                  up={pulse.changePercent24h >= 0}
                />
                <MiniStat
                  label="量能对比"
                  value={`${pulse.volumeRatio.toFixed(2)}x`}
                  up={pulse.volumeRatio >= 1}
                />
                <MiniStat
                  label="24h 波动率"
                  value={`${pulse.volatility24h.toFixed(2)}%`}
                  up={false}
                />
                <MiniStat label="24h 振幅" value={formatPct(amplitude(pulse))} up={false} />
              </div>
              <div className="mt-4">
                <span className="muted-text">关键词热度</span>
                <div className="mt-2">
                  <KeywordBars items={data?.keywordTrends?.slice(0, 6) ?? []} />
                </div>
              </div>
            </>
          ) : (
            <div className="py-10 text-center text-[12px] text-muted">行情数据不足，暂无市场动向</div>
          )}
        </div>
      </section>

      {/* 数据源 + 余额 */}
      <section className="grid gap-4 lg:grid-cols-3">
        <div className="glass-card p-4">
          <span className="section-title">数据源状态</span>
          <div className="mt-3 flex flex-col gap-2.5">
            {(data?.dataSources ?? []).map((source) => (
              <div key={source.name} className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 rounded-full',
                      source.ok ? 'bg-up animate-pulse-dot' : 'bg-warn',
                    )}
                  />
                  <span className="text-[12px] text-white/85">{source.label}</span>
                </div>
                <span className="max-w-[58%] text-right text-[11px] text-muted">
                  {source.message}
                </span>
              </div>
            ))}
            {(data?.dataSources ?? []).length === 0 ? (
              <div className="py-6 text-center text-[11px] text-muted">暂无数据源状态</div>
            ) : null}
          </div>
          <div className="divider-x my-4" />
          <div className="flex flex-wrap gap-2">
            <LivePulse ok={Boolean(data?.llmAvailable)} text={data?.llmAvailable ? '模型在线' : '模型降级'} />
            <LivePulse ok={Boolean(data?.agentEnabled)} text={data?.agentEnabled ? 'Agent 运行中' : 'Agent 已停止'} />
          </div>
        </div>

        <div className="glass-card p-4 lg:col-span-2">
          <span className="section-title">账户余额</span>
          <Table
            className="mt-3"
            size="small"
            rowKey={(row) => `${row.exchange}-${row.asset}`}
            pagination={false}
            dataSource={data?.balances ?? []}
            locale={{ emptyText: <span className="text-[12px] text-muted">未读取到余额</span> }}
            columns={[
              { title: '资产', dataIndex: 'asset', render: (v: string) => <span className="text-white">{v}</span> },
              {
                title: '可用',
                dataIndex: 'free',
                align: 'right',
                render: (v: number) => <span className="num">{formatUsd(v, 6)}</span>,
              },
              {
                title: '冻结',
                dataIndex: 'locked',
                align: 'right',
                render: (v: number) => <span className="num text-subtle">{formatUsd(v, 6)}</span>,
              },
              {
                title: '合计',
                dataIndex: 'total',
                align: 'right',
                render: (v: number) => <span className="num text-white">{formatUsd(v, 6)}</span>,
              },
              {
                title: 'USDT 估值',
                dataIndex: 'usdtValue',
                align: 'right',
                render: (v: number) => (
                  <span className="num text-btc-light">{formatUsd(v)}</span>
                ),
              },
            ]}
          />
          <p className="mt-2 text-[11px] text-muted">
            估值以 BTCUSDT 现价折算，仅 USDT / BTC 参与折价；其余资产估值为 0，不计入总估值。
          </p>
        </div>
      </section>

      {/* 当前仓位单（Lot）：订单级独立止盈止损 */}
      <section className="glass-card p-4">
        <div className="mb-3 flex items-center gap-1.5">
          <span className="section-title">当前仓位单</span>
          <InfoHint
            text={
              <div className="text-[11px] leading-relaxed">
                <div>· 每笔开仓 = 一个仓位单，独立止盈止损（本单落库快照）</div>
                <div>· 浮动盈亏按现价计算；多头与空头（合约锁仓）分别显示</div>
                <div>· 触发止盈止损或手动平仓后全量了结，该单才算完结</div>
                <div className="mt-1 text-white/60">出场 = 全量平掉对应仓位单，不做部分卖出</div>
              </div>
            }
          />
        </div>
        {openLots.length > 0 ? (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={openLots}
            scroll={{ x: 900 }}
            columns={[
              {
                title: '市场',
                dataIndex: 'market',
                width: 90,
                render: (v: 'spot' | 'futures') => (
                  <Tag color={v === 'futures' ? 'purple' : 'blue'}>{MARKET_LABELS[v]}</Tag>
                ),
              },
              {
                title: '方向',
                dataIndex: 'direction',
                width: 90,
                render: (v: 'LONG' | 'SHORT') => (
                  <span className={v === 'LONG' ? 'text-up' : 'text-down'}>{v === 'LONG' ? '做多' : '做空'}</span>
                ),
              },
              {
                title: '开仓数量',
                dataIndex: 'quantity',
                width: 110,
                align: 'right',
                render: (v: number) => <span className="num">{formatQty(v)} BTC</span>,
              },
              {
                title: '入场价',
                dataIndex: 'entryPrice',
                width: 120,
                align: 'right',
                render: (v: number) => <span className="num">{formatPrice(v)}</span>,
              },
              {
                title: '浮动盈亏',
                key: 'unrealizedPnl',
                width: 140,
                align: 'right',
                render: (_, row) => {
                  if (row.unrealizedPnl === null)
                    return <span className="text-[11px] text-muted">--</span>;
                  return (
                    <span className={`num ${trendClass(row.unrealizedPnl)}`}>
                      {formatSignedUsd(row.unrealizedPnl)} USDT
                    </span>
                  );
                },
              },
              {
                title: '开仓时间',
                dataIndex: 'openedAt',
                width: 160,
                render: (v: string) => (
                  <span className="num text-[11px] text-muted">{formatTime(v)}</span>
                ),
              },
            ]}
          />
        ) : (
          <div className="py-6 text-center text-[12px] text-muted">当前没有持仓中的仓位单</div>
        )}
      </section>

      {/* 近期篮子：一轮「建仓 → 全部了结」的整体表现 + 各层明细 */}
      <section className="glass-card p-4">
        <div className="mb-3 flex items-center gap-1.5">
          <span className="section-title">近期篮子</span>
          <InfoHint
            text={
              <div className="text-[11px] leading-relaxed">
                <div>· 一个篮子 = 一轮「建仓 → 全部了结」的完整周期（马丁网格的一个循环）</div>
                <div>· 「整体盈亏」把该篮子所有层合起来算，已含双边手续费</div>
                <div>· 加层时中间层必然浮亏，单笔订单盈亏没有意义，所以按篮子看</div>
                <div className="mt-1 text-white/60">展开某一行可看该篮子每一层的开平仓与盈亏</div>
              </div>
            }
          />
        </div>
        <Table<BasketSummary>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 1040 }}
          dataSource={data?.recentBaskets ?? []}
          locale={{ emptyText: <span className="text-[12px] text-muted">暂无篮子</span> }}
          expandable={{
            expandedRowRender: (basket) => (
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
                    title: '平仓价',
                    dataIndex: 'exitPrice',
                    align: 'right',
                    render: (v: number | null) =>
                      v === null ? (
                        <span className="num text-[11px] text-muted">--</span>
                      ) : (
                        <span className="num">{formatPrice(v)}</span>
                      ),
                  },
                  {
                    title: '层盈亏',
                    dataIndex: 'realizedPnl',
                    align: 'right',
                    render: (v: number | null, lot) =>
                      v === null ? (
                        <span className="text-[11px] text-muted">持仓中</span>
                      ) : (
                        <div className="num leading-tight">
                          <span className={trendClass(v)}>{formatSignedUsd(v)}</span>
                          {lot.returnPct !== null ? (
                            <div className="text-[10px] text-muted">
                              {formatPct(lot.returnPct * 100)}
                            </div>
                          ) : null}
                        </div>
                      ),
                  },
                  {
                    title: '开仓单号',
                    dataIndex: 'openOrderId',
                    render: (v: string) => (
                      <span className="num text-[10px] text-muted">{v.slice(0, 8)}</span>
                    ),
                  },
                  {
                    title: '开仓时间',
                    dataIndex: 'openedAt',
                    render: (v: string) => (
                      <span className="num text-[11px] text-muted">{formatTime(v)}</span>
                    ),
                  },
                ]}
              />
            ),
          }}
          columns={[
            {
              title: '篮子编号',
              dataIndex: 'code',
              render: (v: string, row) => (
                <div className="flex items-center gap-1.5">
                  <span className="num text-[12px] text-white">{v}</span>
                  {row.status === 'OPEN' ? (
                    <Tag color="processing" className="!mr-0">
                      持仓中
                    </Tag>
                  ) : (
                    <Tag className="!mr-0">已了结</Tag>
                  )}
                </div>
              ),
            },
            {
              title: '方向',
              dataIndex: 'direction',
              render: (v: string) =>
                v === 'MIXED' ? (
                  <Tag color="gold">双向</Tag>
                ) : (
                  <SideTag side={v === 'LONG' ? 'BUY' : 'SELL'} />
                ),
            },
            {
              title: '来源',
              dataIndex: 'origin',
              render: (v: string) => (
                <span className="text-[11px] text-muted">
                  {v === 'strategy' ? '策略' : v === 'manual' ? '手动' : '混合'}
                </span>
              ),
            },
            {
              title: '层数',
              dataIndex: 'layerCount',
              align: 'right',
              render: (v: number) => <span className="num">{v}</span>,
            },
            {
              title: '开仓均价',
              dataIndex: 'avgEntryPrice',
              align: 'right',
              render: (v: number) => <span className="num">{formatPrice(v)}</span>,
            },
            {
              title: '平仓均价',
              dataIndex: 'avgExitPrice',
              align: 'right',
              render: (v: number | null) =>
                v === null ? (
                  <span className="num text-[11px] text-muted">--</span>
                ) : (
                  <span className="num">{formatPrice(v)}</span>
                ),
            },
            {
              title: '整体盈亏',
              key: 'pnl',
              align: 'right',
              render: (_, row) => {
                // 交易所口径净收益 = 各层已实现（含开平手续费）+ 资金费（持仓费用）+ 未平浮盈。
                // 资金费不产生成交，只有算进来才与账户真实到账一致。
                const pnl =
                  row.realizedPnl +
                  row.fundingFee +
                  (row.status === 'CLOSED' ? 0 : row.unrealizedPnl);
                return (
                  <div className={clsx('num leading-tight', trendClass(pnl))}>
                    <div>{formatSignedUsd(pnl)}</div>
                    <div className="text-[10px] text-muted">
                      {row.status === 'CLOSED' ? '已实现' : '含浮动'}
                    </div>
                  </div>
                );
              },
            },
            {
              title: '资金费',
              dataIndex: 'fundingFee',
              align: 'right',
              render: (v: number) => (
                <Tooltip title="持仓费用（交易所每 8 小时结算，不产生成交）">
                  <span className={clsx('num', v === 0 ? 'text-muted' : trendClass(v))}>
                    {formatSignedUsd(v)}
                  </span>
                </Tooltip>
              ),
            },
            {
              title: '收益率',
              dataIndex: 'returnPct',
              align: 'right',
              render: (v: number | null) =>
                v === null ? (
                  <span className="text-[11px] text-muted">--</span>
                ) : (
                  <span className={clsx('num', trendClass(v))}>{formatPct(v * 100)}</span>
                ),
            },
            {
              title: '开仓时间',
              dataIndex: 'openedAt',
              render: (v: string) => (
                <span className="num text-[11px] text-muted">{formatTime(v)}</span>
              ),
            },
            {
              title: '了结时间',
              dataIndex: 'closedAt',
              render: (v: string | null) => (
                <span className="num text-[11px] text-muted">{v ? formatTime(v) : '--'}</span>
              ),
            },
          ]}
        />
      </section>
    </div>
  );
}

function MiniStat({ label, value, up }: { label: string; value: string; up: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
      <div className="muted-text">{label}</div>
      <div className={clsx('num mt-1 text-[16px] font-semibold', up ? 'text-up' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/** 24h 振幅 = (高 − 低) / 低 × 100 */
function amplitude(pulse: { high24h: number; low24h: number }): number | undefined {
  const { high24h, low24h } = pulse;
  if (!(high24h > 0) || !(low24h > 0)) return undefined;
  return ((high24h - low24h) / low24h) * 100;
}

const SOURCE_LINE = (
  <div className="mt-2 border-t border-white/10 pt-1.5 text-white/60">
    数据来源：本地 K 线存储（启动时由币安现货公共 REST 拉取全周期历史，之后由 WebSocket
    @kline_1m + @bookTicker 双流秒级增量更新）。外部不可达时降级为模拟行情，此时「数据源状态」会标注。
  </div>
);

function SentimentFormula() {
  return (
    <div className="text-[11px] leading-relaxed">
      <div className="mb-1 font-medium">市场情绪怎么算的</div>
      <div className="num">score = clamp(A × 4 + B × 25 + C × 20 − 10, −100, 100)</div>
      <div className="mt-1">· A = 24h 涨跌幅（%）</div>
      <div>· B = (MA6 − MA24) / MA24 × 100，基于 1h K 线收盘价</div>
      <div>· C = (现价 − 24h 低) / (24h 高 − 24h 低)，价格在日内区间的位置</div>
      <div className="mt-1">判定：score &gt; 15 偏强；&lt; −15 偏弱；否则震荡</div>
      {SOURCE_LINE}
    </div>
  );
}

function PulseFormula() {
  return (
    <div className="text-[11px] leading-relaxed">
      <div className="mb-1 font-medium">今日市场动向各项的口径</div>
      <div>· 24h 涨跌 = (现价 − 24h 前开盘价) / 开盘价，窗口为最近 1440 根 1m K 线</div>
      <div>· 量能对比 = 最近 24 根 1h 成交量 / 前 24 根 1h 成交量</div>
      <div>· 24h 波动率 = 最近 24 根 1h 收盘价收益率的标准差（日频，未年化）</div>
      <div>· 24h 振幅 = (24h 高 − 24h 低) / 24h 低</div>
      <div>· 关键词热度 = 最近 200 条新闻标签的词频统计</div>
      {SOURCE_LINE}
    </div>
  );
}
