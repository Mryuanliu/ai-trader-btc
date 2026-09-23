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

/**
 * 仓位单（Lot）的止损/止盈**价格点位**。
 *
 * 按方向换算：LONG 止损在下（entry×(1−sl)）、止盈在上；SHORT 相反。
 * 前端三处（订单页/总览/合约面板）共用同一算法，保证展示口径一致，
 * 与服务端 checkLotExit 的判定公式（entry×(1±pct)）严格对齐。
 */
export function lotStopPrice(direction: string, entryPrice: number, stopLossPct: number): number {
  if (!(entryPrice > 0)) return 0;
  return direction === 'LONG' ? entryPrice * (1 - stopLossPct) : entryPrice * (1 + stopLossPct);
}

export function lotTakeProfitPrice(
  direction: string,
  entryPrice: number,
  takeProfitPct: number,
): number {
  if (!(entryPrice > 0)) return 0;
  return direction === 'LONG' ? entryPrice * (1 + takeProfitPct) : entryPrice * (1 - takeProfitPct);
}
