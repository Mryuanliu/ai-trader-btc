import { useMemo } from 'react';
import { Area, AreaChart, ResponsiveContainer, YAxis } from 'recharts';
import type { Candle } from '@ai-trader/shared';

interface Props {
  candles: Candle[];
  height?: number;
  up?: boolean;
}

export function Sparkline({ candles, height = 64, up = true }: Props) {
  const data = useMemo(
    () =>
      candles.slice(-120).map((c) => ({
        time: c.time,
        value: c.close,
      })),
    [candles],
  );

  if (data.length === 0) {
    return <div className="h-16 rounded-lg bg-white/[0.03]" />;
  }

  const stroke = up ? '#0ECB81' : '#F6465D';
  const gradientId = up ? 'spark-up' : 'spark-down';

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 关键词热度横向条形图 */
export function KeywordBars({
  items,
  onSelect,
}: {
  items: { keyword: string; count: number }[];
  onSelect?: (keyword: string) => void;
}) {
  if (items.length === 0) {
    return <div className="muted-text py-6 text-center">暂无关键词统计</div>;
  }
  const max = Math.max(...items.map((i) => i.count), 1);

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <button
          key={item.keyword}
          onClick={() => onSelect?.(item.keyword)}
          className="group flex items-center gap-3 text-left"
        >
          <span className="w-16 shrink-0 truncate text-[11px] text-subtle group-hover:text-btc-light">
            {item.keyword}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <span
              className="block h-full rounded-full bg-btc-gradient transition-all duration-500"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </span>
          <span className="num w-6 shrink-0 text-right text-[11px] text-muted">{item.count}</span>
        </button>
      ))}
    </div>
  );
}
