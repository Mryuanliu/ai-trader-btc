import { useMemo, useState } from 'react';
import { Calendar, Tooltip } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { DailyRealizedPnl } from '@ai-trader/shared';
import { formatSignedUsd } from '@/utils/format';

/** 币安配色：涨绿 / 跌红（与全站 theme token 一致） */
const UP_RGB = '14,203,129';
const DOWN_RGB = '246,70,93';

/**
 * 已实现盈亏日历（基于 antd Calendar 月视图）。
 *
 * 只统计「已平仓 Lot」按自然日聚合的已实现盈亏，按**平仓日**归属，
 * 不含浮动盈亏与资金费——数据来自 OverviewDTO.pnlCalendar（后端按 Asia/Shanghai 自然日聚合）。
 * 可点左上角切换月份/年份查看历史（后端仅回填近 91 天，更早月份自然为空）。
 */
export function PnlCalendar({ data }: { data: DailyRealizedPnl[] }) {
  const [panel, setPanel] = useState<Dayjs>(() => dayjs());

  const byDate = useMemo(() => new Map(data.map((d) => [d.date, d])), [data]);
  const maxAbs = useMemo(
    () => data.reduce((m, d) => Math.max(m, Math.abs(d.realizedPnl)), 0),
    [data],
  );
  // 当前面板月份的已实现合计与交易天数（随翻页动态变化）
  const monthStat = useMemo(() => {
    const prefix = panel.format('YYYY-MM');
    let total = 0;
    let days = 0;
    for (const d of data) {
      if (d.date.startsWith(prefix)) {
        total += d.realizedPnl;
        if (d.trades > 0) days += 1;
      }
    }
    return { total, days };
  }, [data, panel]);

  const renderDateCell = (current: Dayjs) => {
    const key = current.format('YYYY-MM-DD');
    const rec = byDate.get(key);
    const inMonth = current.month() === panel.month() && current.year() === panel.year();
    const isFuture = current.isAfter(dayjs(), 'day');
    const pnl = rec?.realizedPnl ?? 0;
    const ratio = maxAbs > 0 ? Math.min(1, Math.abs(pnl) / maxAbs) : 0;
    const rgb = pnl > 0 ? UP_RGB : DOWN_RGB;
    const background =
      rec && !isFuture && pnl !== 0
        ? `rgba(${rgb},${(0.08 + ratio * 0.30).toFixed(3)})`
        : undefined;

    return (
      <div
        className="flex h-full min-h-[74px] flex-col justify-between rounded-lg p-1.5 transition-colors"
        style={{ background, opacity: inMonth ? 1 : 0.35 }}
      >
        <span className="num self-end text-[11px] text-muted">{current.date()}</span>
        {rec && !isFuture ? (
          <Tooltip
            title={
              <div className="text-[11px] leading-relaxed">
                <div className="num">{key} 已实现</div>
                <div className="num">{formatSignedUsd(rec.realizedPnl)} USDT</div>
                <div className="text-white/60">了结 {rec.trades} 笔</div>
              </div>
            }
          >
            <span
              className="num text-[12px] font-semibold leading-tight"
              style={{ color: pnl === 0 ? undefined : `rgb(${rgb})` }}
            >
              {formatSignedUsd(rec.realizedPnl)}
            </span>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="section-title">盈亏日历</span>
        <span className="text-[11px] text-muted">
          {panel.format('YYYY年M月')}已实现{' '}
          <span
            className="num font-semibold"
            style={{
              color:
                monthStat.total > 0
                  ? `rgb(${UP_RGB})`
                  : monthStat.total < 0
                    ? `rgb(${DOWN_RGB})`
                    : undefined,
            }}
          >
            {formatSignedUsd(monthStat.total)}
          </span>{' '}
          · 交易 {monthStat.days} 天
        </span>
      </div>
      <div className="pnl-calendar flex-1">
        <Calendar
          fullscreen
          value={panel}
          onPanelChange={(d) => setPanel(d)}
          cellRender={(current, info) => (info.type === 'date' ? renderDateCell(current) : info.originNode)}
        />
      </div>
    </div>
  );
}
