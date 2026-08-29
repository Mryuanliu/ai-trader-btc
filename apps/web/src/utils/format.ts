import dayjs from 'dayjs';

export function formatPrice(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatQty(value: number | undefined | null, digits = 6): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

export function formatUsd(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatPct(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatSignedUsd(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function trendClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) {
    return 'text-white/80';
  }
  return value > 0 ? 'text-up' : 'text-down';
}

export function formatTime(input?: string | number | Date | null): string {
  if (!input) return '--';
  return dayjs(input).format('MM-DD HH:mm:ss');
}

export function formatRelative(input?: string | number | Date | null): string {
  if (!input) return '--';
  const target = dayjs(input);
  const diff = dayjs().diff(target, 'second');
  if (diff < 60) return `${Math.max(diff, 0)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}
