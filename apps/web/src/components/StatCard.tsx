import clsx from 'clsx';
import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'up' | 'down' | 'warn' | 'btc';
  className?: string;
  onClick?: () => void;
}

const TONE_RING: Record<string, string> = {
  default: 'before:from-white/12 before:to-transparent',
  up: 'before:from-up/45 before:to-transparent',
  down: 'before:from-down/45 before:to-transparent',
  warn: 'before:from-warn/45 before:to-transparent',
  btc: 'before:from-btc/55 before:to-transparent',
};

export function StatCard({ label, value, hint, icon, tone = 'default', className, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'glass-card overflow-hidden p-4',
        onClick && 'cursor-pointer glass-card-hover',
        'before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:content-[""]',
        TONE_RING[tone],
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="muted-text tracking-wide">{label}</span>
        {icon ? <span className="text-btc/85">{icon}</span> : null}
      </div>
      <div className="num mt-2 text-[22px] font-semibold leading-tight text-white">{value}</div>
      {hint ? <div className="mt-1.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}
