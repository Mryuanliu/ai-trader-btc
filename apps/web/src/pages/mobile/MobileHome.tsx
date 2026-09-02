import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Coins, Bot, ArrowDownUp, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useFuturesConfig, useOpenLots, useOrders } from '@/api/hooks';
import { OrderStatusTag, SideTag } from '@/components/OrderStatusTag';
import { Sparkline } from '@/components/Sparkline';
import { useCandles } from '@/api/hooks';
import { formatPct, formatPrice, formatQty, formatTime } from '@/utils/format';

/**
 * 移动端首页（合约专用）。
 * 展示合约引擎状态、当前合约持仓（仓位单）、近期合约订单与 BTC 走势。
 * 合约开/平仓到 PC 端「合约」页操作。
 */
export function MobileHome() {
  const navigate = useNavigate();
  const { data: candles = [] } = useCandles('BTCUSDT', '5m', 120);
  const { data: futuresCfg } = useFuturesConfig();
  const { data: openLots = [] } = useOpenLots({ market: 'futures' });
  const { data: ordersData } = useOrders({ page: 1, pageSize: 6, market: 'futures' });

  const enabled = futuresCfg?.enabled ?? false;
  const longQty = openLots
    .filter((l) => l.direction === 'LONG')
    .reduce((a, l) => a + l.quantity, 0);
  const shortQty = openLots
    .filter((l) => l.direction === 'SHORT')
    .reduce((a, l) => a + l.quantity, 0);
  const recentOrders = ordersData?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* 合约资产总览 */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="glass-card p-5"
      >
        <div className="flex items-center justify-between">
          <span className="muted-text">合约持仓（仓位单）</span>
          <Zap size={16} className="text-btc/80" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <div className="muted-text">做多</div>
            <div className="num mt-0.5 text-[18px] text-up">{formatQty(longQty)} BTC</div>
          </div>
          <div>
            <div className="muted-text">做空</div>
            <div className="num mt-0.5 text-[18px] text-down">{formatQty(shortQty)} BTC</div>
          </div>
        </div>
        <div className="divider-x my-4" />
        <div className="flex items-center justify-between text-[12px]">
          <span className="muted-text">合约引擎</span>
          <span
            className={clsx(
              'chip',
              enabled ? 'border-up/25 text-up' : 'border-white/12 text-muted',
            )}
          >
            {enabled ? '运行中' : '已停止'}
          </span>
        </div>
        <div className="mt-2 h-10 w-full">
          <Sparkline candles={candles} up={candles.length > 1 && candles[candles.length - 1].close >= candles[0].close} height={40} />
        </div>
      </motion.section>

      {/* 引擎状态 */}
      <motion.button
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05 }}
        onClick={() => navigate('/m/agent')}
        className="glass-card glass-card-hover p-4 text-left"
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-medium text-white">
            <Bot size={16} className="text-btc-light" /> 合约引擎状态
          </span>
          <span
            className={clsx(
              'chip',
              enabled ? 'border-up/25 text-up' : 'border-white/12 text-muted',
            )}
          >
            {enabled ? '运行中' : '已停止'}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          开仓/平仓、策略与止盈止损配置请到 PC 端「合约」页操作
        </p>
      </motion.button>

      {/* 快捷操作 */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1 }}
        className="grid grid-cols-1 gap-3"
      >
        <button
          onClick={() => navigate('/m/trade')}
          className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-btc-gradient text-[15px] font-semibold text-ink-900 shadow-glow active:scale-[0.98]"
        >
          <ArrowDownUp size={17} /> 查看行情与持仓
        </button>
      </motion.section>

      {/* 最近合约订单 */}
      <section className="glass-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="section-title">最近合约订单</span>
          <button
            onClick={() => navigate('/m/orders')}
            className="text-[11px] text-btc-light hover:underline"
          >
            全部
          </button>
        </div>
        {recentOrders.length ? (
          <div className="flex flex-col gap-2.5">
            {recentOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={clsx('h-8 w-1 rounded-full', order.side === 'BUY' ? 'bg-up' : 'bg-down')}
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-[12px] text-white">
                      <SideTag side={order.side} />
                      {order.type === 'MARKET' ? '市价' : '限价'}
                    </div>
                    <div className="num mt-0.5 text-[10px] text-muted">{formatTime(order.createdAt)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-[12px] text-white">{formatQty(order.quantity, 6)} BTC</div>
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
            <span className="text-[12px]">暂无合约订单</span>
          </div>
        )}
      </section>
    </div>
  );
}
