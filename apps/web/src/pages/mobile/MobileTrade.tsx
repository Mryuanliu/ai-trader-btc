import { useState } from 'react';
import clsx from 'clsx';
import { Segmented, Skeleton } from 'antd';
import { TrendingUp, Flame } from 'lucide-react';
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@ai-trader/shared';
import { useCandles, useMarketPulse, useOverview } from '@/api/hooks';
import { KlineChart } from '@/components/KlineChart';
import { OrderPanel } from '@/components/OrderPanel';
import { StatCard } from '@/components/StatCard';
import { formatPct, formatPrice } from '@/utils/format';

export function MobileTrade() {
  const [interval, setInterval] = useState<Timeframe>('5m');
  const [panel, setPanel] = useState<{ side: 'BUY' | 'SELL' } | null>(null);
  const { data: candles = [], isLoading } = useCandles('BTCUSDT', interval, 200);
  const { data: pulse } = useMarketPulse('BTCUSDT');
  const { data } = useOverview();

  const quoteFree =
    data?.balances?.filter((b) => b.asset === 'USDT').reduce((a, b) => a + b.free, 0) ?? 0;
  const baseFree =
    data?.balances?.filter((b) => b.asset === 'BTC').reduce((a, b) => a + b.free, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <Segmented
            size="small"
            value={interval}
            onChange={(v) => setInterval(v as Timeframe)}
            options={TIMEFRAMES.map((tf) => ({ label: TIMEFRAME_LABELS[tf], value: tf }))}
          />
        </div>
        {isLoading && candles.length === 0 ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <KlineChart candles={candles} height={260} resetKey={interval} />
        )}
      </section>

      {pulse ? (
        <section className="grid grid-cols-2 gap-3">
          <StatCard
            label="24h 涨跌"
            value={formatPct(pulse.changePercent24h)}
            tone={pulse.changePercent24h >= 0 ? 'up' : 'down'}
            icon={<TrendingUp size={15} />}
            hint={`高 ${formatPrice(pulse.high24h)} / 低 ${formatPrice(pulse.low24h)}`}
          />
          <StatCard
            label="量能对比"
            value={`${pulse.volumeRatio.toFixed(2)}x`}
            tone={pulse.volumeRatio >= 1 ? 'btc' : 'default'}
            icon={<Flame size={15} />}
            hint={`24h 波动率 ${pulse.volatility24h.toFixed(2)}%`}
          />
        </section>
      ) : null}

      {pulse ? (
        <section className="glass-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="section-title">市场动向</span>
            <span
              className={clsx(
                'chip',
                pulse.sentiment === 'bullish'
                  ? 'border-up/25 text-up'
                  : pulse.sentiment === 'bearish'
                    ? 'border-down/25 text-down'
                    : 'border-white/12 text-subtle',
              )}
            >
              {pulse.sentiment === 'bullish' ? '偏强' : pulse.sentiment === 'bearish' ? '偏弱' : '震荡'}
              · {pulse.sentimentScore.toFixed(0)}
            </span>
          </div>
          <p className="text-[12px] leading-relaxed text-subtle">{pulse.summary}</p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 pb-2">
        <button
          onClick={() => setPanel({ side: 'BUY' })}
          className="h-14 rounded-2xl bg-btc-gradient text-[15px] font-semibold text-ink-900 shadow-glow active:scale-[0.98]"
        >
          买入 BTC
        </button>
        <button
          onClick={() => setPanel({ side: 'SELL' })}
          className="h-14 rounded-2xl border border-down/35 bg-down/12 text-[15px] font-semibold text-down active:scale-[0.98]"
        >
          卖出 BTC
        </button>
      </section>

      <OrderPanel
        open={Boolean(panel)}
        onClose={() => setPanel(null)}
        side={panel?.side ?? 'BUY'}
        price={data?.ticker?.price ?? 0}
        quoteFree={quoteFree}
        baseFree={baseFree}
        mode={data?.mode}
      />
    </div>
  );
}
