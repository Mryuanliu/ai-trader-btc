import { describe, expect, it } from 'vitest';
import { monthsInRange, parseKlinesCsv } from '../pull/klines-archive';

const MS = (s: string) => Date.parse(s);

describe('monthsInRange', () => {
  it('单月区间只产出一个 YYYY-MM', () => {
    const r = monthsInRange(MS('2026-09-01'), MS('2026-09-30'), 40);
    expect(r).toEqual(['2026-09']);
  });

  it('跨年按月升序枚举且含端点所在月', () => {
    const r = monthsInRange(MS('2023-11-15'), MS('2024-02-03'), 40);
    expect(r).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
  });

  it('超出 maxMonths 截断', () => {
    const r = monthsInRange(MS('2020-01-01'), MS('2026-12-31'), 3);
    expect(r).toEqual(['2020-01', '2020-02', '2020-03']);
  });
});

describe('parseKlinesCsv', () => {
  const symbol = 'BTCUSDT';
  const interval = '1m' as const;
  // 时间窗：与下方 open_time（1756684800000=00:00）同一纪元，仅中间三根落在区间内
  const from = 1756684860000; // 00:01
  const to = 1756684980000; // 00:03

  const headerCsv = [
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    '1756684800000,1,1,1,1,10,1756684859999,10,1,1,1,0', // 00:00 区间前 → 丢弃
    '1756684860000,2,3,1,2,20,1756684919999,40,2,2,2,0', // 00:01 → 保留
    '1756684920000,4,5,3,4,30,1756684979999,60,3,3,3,0', // 00:02 → 保留
    '1756684980000,6,7,5,6,40,1756685039999,80,4,4,4,0', // 00:03 边界 → 保留（含 to）
    '',
  ].join('\n');

  it('跳过表头、按列序映射字段、区间过滤（含右端点）', () => {
    const rows = parseKlinesCsv(headerCsv, symbol, interval, from, to);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      symbol,
      market: 'futures',
      interval,
      openTime: 1756684860000,
      open: 2,
      high: 3,
      low: 1,
      close: 2,
      volume: 20,
    });
    expect(rows.map((r) => r.openTime)).toEqual([1756684860000, 1756684920000, 1756684980000]);
  });

  it('无表头的早期文件（首行即数据）正确解析', () => {
    const noHeader = '1756684860000,2,3,1,2,20,1756684919999,40,2,2,2,0';
    const rows = parseKlinesCsv(noHeader, symbol, interval, from, to);
    expect(rows).toHaveLength(1);
    expect(rows[0].close).toBe(2);
  });

  it('列数不足（<6）的残行被跳过', () => {
    const dirty = [
      'open_time,open,high,low,close,volume',
      '1756684860000,2,3,1,2', // 仅 5 列 → 跳过
      '1756684920000,4,5,3,4,30', // 6 列 → 保留
      '1756684980000,6,7,5,6,40',
    ].join('\n');
    const rows = parseKlinesCsv(dirty, symbol, interval, from, to);
    expect(rows).toHaveLength(2);
  });

  it('非数字 open_time（垃圾行）被丢弃', () => {
    const bad = 'open_time,open,high,low,close,volume\nabc,1,1,1,1,1\n1756684860000,2,2,2,2,2';
    const rows = parseKlinesCsv(bad, symbol, interval, from, to);
    expect(rows).toHaveLength(1);
  });
});
