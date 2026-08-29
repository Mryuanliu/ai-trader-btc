import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatPct, formatPrice } from '@/utils/format';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

interface Props {
  price: number;
  changePercent?: number;
  symbol?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function PriceTicker({ price, changePercent = 0, symbol, size = 'md', className }: Props) {
  const prev = useRef(price);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (price === prev.current) return;
    setFlash(price > prev.current ? 'up' : 'down');
    prev.current = price;
    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [price]);

  const up = changePercent >= 0;
  const priceSize =
    size === 'lg' ? 'text-[34px]' : size === 'md' ? 'text-[24px]' : 'text-[17px]';

  return (
    <div className={clsx('flex flex-col gap-0.5', className)}>
      {symbol ? <span className="muted-text tracking-wide">{symbol}</span> : null}
      <div className="flex items-end gap-2.5">
        <span
          key={price}
          className={clsx(
            'num font-semibold text-white transition-colors',
            priceSize,
            flash === 'up' && 'animate-flash-up',
            flash === 'down' && 'animate-flash-down',
          )}
        >
          {formatPrice(price)}
        </span>
        <span
          className={clsx(
            'mb-1 flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium',
            up ? 'bg-up/12 text-up' : 'bg-down/12 text-down',
          )}
        >
          {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          {formatPct(changePercent)}
        </span>
      </div>
    </div>
  );
}
