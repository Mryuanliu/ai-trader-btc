import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Wallet, Coins, Bot, ArrowDownUp, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useOverview } from '@/api/hooks';
import { StatCard } from '@/components/StatCard';
import { OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { OrderPanel } from '@/components/OrderPanel';
import { Sparkline } from '@/components/Sparkline';
import { useCandles } from '@/api/hooks';
import { formatPct, formatPrice, formatQty, formatSignedUsd, formatTime } from '@/utils/format';

export function MobileHome() {
  const navigate = useNavigate();
  const { data } = useOverview();
  const { data: candles = [] } = useCandles('BTCUSDT', '5m', 120);
  const [panel, setPanel] = useState<{ side: 'BUY' | 'SELL' } | null>(null);

  const totals = data?.totals;
  const pnl = totals?.pnlToday ?? 0;
  const up = pnl >= 0;
  const quoteFree =
    data?.balances?.filter((b) => b.asset === 'USDT').reduce((a, b) => a + b.free, 0) ?? 0;
  const baseFree =
    data?.balances?.filter((b) => b.asset === 'BTC').reduce((a, b) => a + b.free, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 资产总览 */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="glass-card p-5"
      >
        <div className="flex items-center justify-between">
          <span className="muted-text">总资产估值</span>
          <Wallet size={16} className="text-btc/80" />
        </div>
        <div className="num mt-2 text-[32px] font-semibold leading-none text-white">
          {formatPrice(totals?.usdtValue ?? 0)}
          <span className="ml-1.5 text-[14px] font-normal text-muted">USDT</span>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="muted-text">今日盈亏</div>
            <div className={clsx('num text-[16px] font-semibold', up ? 'text-up' : 'text-down')}>
              {formatSignedUsd(pnl)} USDT
              <span className="ml-1.5 text-[11px] font-normal">
                {formatPct(totals?.pnlTodayPct ?? 0)}
              </span>
            </div>
          </div>
          <div className="h-10 w-28">
            <Sparkline candles={candles} up={up} height={40} />
          </div>
        </div>
        <div className="divider-x my-4" />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="muted-text">可用 USDT</div>
            <div className="num mt-0.5 text-[15px] text-white">{formatPrice(quoteFree)}</div>
          </div>
          <div>
            <div className="muted-text">持仓 BTC</div>
            <div className="num mt-0.5 text-[15px] text-white">{formatQty(baseFree)}</div>
          </div>
        </div>
      </motion.section>

      {/* Agent 状态 */}
      <motion.button
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05 }}
        onClick={() => navigate('/m/agent')}
        className="glass-card glass-card-hover p-4 text-left"
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-medium text-white">
            <Bot size={16} className="text-btc-light" /> Agent 状态
          </span>
          <span
            className={clsx(
              'chip',
              data?.agentEnabled ? 'border-up/25 text-up' : 'border-white/12 text-muted',
            )}
          >
            <span
              className={clsx(
                'h-1.5 w-1.5 rounded-full',
                data?.agentEnabled ? 'bg-up animate-pulse-dot' : 'bg-muted',
              )}
            />
            {data?.agentEnabled ? '运行中' : '已停止'}
          </span>
        </div>
        {data?.recentDecisions?.[0] ? (
          <div className="mt-3">
            <div className="flex items-center gap-2 text-[12px] text-subtle">
              <span>最近决策</span>
              <span className="text-white">
                {data.recentDecisions[0].action === 'BUY'
                  ? '买入'
                  : data.recentDecisions[0].action === 'SELL'
                    ? '卖出'
                    : '观望'}
              </span>
              <span className="num text-btc-light">
                置信度 {(data.recentDecisions[0].confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
              {data.recentDecisions[0].reason}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-muted">暂无决策记录，可在 Agent 页手动触发一次。</p>
        )}
      </motion.button>

      {/* 快捷操作 */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1 }}
        className="grid grid-cols-2 gap-3"
      >
        <button
          onClick={() => setPanel({ side: 'BUY' })}
          className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-btc-gradient text-[15px] font-semibold text-ink-900 shadow-glow active:scale-[0.98]"
        >
          <Zap size={17} /> 买入
        </button>
        <button
          onClick={() => setPanel({ side: 'SELL' })}
          className="flex h-16 items-center justify-center gap-2 rounded-2xl border border-down/35 bg-down/12 text-[15px] font-semibold text-down active:scale-[0.98]"
        >
          <ArrowDownUp size={17} /> 卖出
        </button>
      </motion.section>

      {/* 最近订单 */}
      <section className="glass-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="section-title">最近订单</span>
          <button
            onClick={() => navigate('/m/orders')}
            className="text-[11px] text-btc-light hover:underline"
          >
            全部
          </button>
        </div>
        {data?.recentOrders?.length ? (
          <div className="flex flex-col gap-2.5">
            {data.recentOrders.slice(0, 6).map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={clsx(
                      'h-8 w-1 rounded-full',
                      order.side === 'BUY' ? 'bg-up' : 'bg-down',
                    )}
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-[12px] text-white">
                      <SideTag side={order.side} />
                      {order.type === 'MARKET' ? '市价' : '限价'}
                    </div>
                    <div className="num mt-0.5 text-[10px] text-muted">
                      {formatTime(order.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-[12px] text-white">
                    {formatQty(order.quantity, 6)} BTC
                  </div>
                  <div className="num text-[10px] text-muted">@ {formatPrice(order.price)}</div>
                  <div className="mt-0.5">
                    <OrderStatusTag status={order.status} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-8 text-muted">
            <Coins size={22} />
            <span className="text-[12px]">暂无订单记录</span>
          </div>
        )}
      </section>

      <OrderPanel
        open={Boolean(panel)}
        onClose={() => setPanel(null)}
        side={panel?.side ?? 'BUY'}
        price={data?.ticker?.price ?? 0}
        quoteFree={quoteFree}
        baseFree={baseFree}
        mode={data?.mode}
        maxOrderAmount={0}
      />
    </div>
  );
}
