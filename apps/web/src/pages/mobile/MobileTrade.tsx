import { useState } from 'react';
import clsx from 'clsx';
import { Segmented, Skeleton } from 'antd';
import { TrendingUp, Flame } from 'lucide-react';
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@ai-trader/shared';
import { useCandles, useMarketPulse, useOpenLots } from '@/api/hooks';
import { KlineChart } from '@/components/KlineChart';
import { StatCard } from '@/components/StatCard';
import { formatPct, formatPrice } from '@/utils/format';

/**
 * 移动端行情页（合约专用）。
 * 合约下单操作请到 PC 端「合约」页（移动端只读展示行情与当前持仓仓位单）。
 */
export function MobileTrade() {
  const [interval, setInterval] = useState<Timeframe>('5m');
  const { data: candles = [], isLoading } = useCandles('BTCUSDT', interval, 200);
  const { data: pulse } = useMarketPulse('BTCUSDT');
  const { data: futuresLots = [] } = useOpenLots({ market: 'futures', symbol: 'BTCUSDT' });

  const longQty = futuresLots
    .filter((l) => l.direction === 'LONG')
    .reduce((a, l) => a + l.quantity, 0);
  const shortQty = futuresLots
    .filter((l) => l.direction === 'SHORT')
    .reduce((a, l) => a + l.quantity, 0);

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

      <section className="glass-card p-4">
        <span className="section-title">合约持仓（本地仓位单）</span>
        <div className="mt-2 flex items-center justify-between text-[12px]">
          <span className="muted-text">做多</span>
          <span className="num text-up">{longQty.toFixed(6)} BTC</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[12px]">
          <span className="muted-text">做空</span>
          <span className="num text-down">{shortQty.toFixed(6)} BTC</span>
        </div>
        <p className="mt-3 text-[11px] text-muted">
          合约开仓/平仓请到 PC 端「合约」页操作（每单独立止盈止损，全量平仓才算完结）
        </p>
      </section>
    </div>
  );
}
