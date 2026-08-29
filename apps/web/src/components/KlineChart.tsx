import { useEffect, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import type { Candle } from '@ai-trader/shared';

interface Props {
  candles: Candle[];
  height?: number;
  showMA?: boolean;
  /** 变化时全量重绘并重置缩放，切换周期或交易对时传入 */
  resetKey?: string;
}

/** 尾部 N 根收盘价的均值，用于增量更新均线最后一个点 */
function maAt(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((acc, c) => acc + c.close, 0) / period;
}

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    const slice = values.slice(i + 1 - period, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

export function KlineChart({ candles, height = 320, showMA = true, resetKey }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  /** 上一次渲染的数据集特征，用于判断该全量重绘还是增量更新 */
  const renderSigRef = useRef<{ key: string; length: number; lastTime: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#A7B1C2',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(247,147,26,0.4)', labelBackgroundColor: '#F7931A' },
        horzLine: { color: 'rgba(247,147,26,0.4)', labelBackgroundColor: '#F7931A' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#0ECB81',
      downColor: '#F6465D',
      borderUpColor: '#0ECB81',
      borderDownColor: '#F6465D',
      wickUpColor: 'rgba(14,203,129,0.85)',
      wickDownColor: 'rgba(246,70,93,0.85)',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: 'rgba(247,147,26,0.35)',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const ma5 = chart.addLineSeries({ color: '#FFB020', lineWidth: 1, priceLineVisible: false });
    const ma20 = chart.addLineSeries({ color: '#2E90FA', lineWidth: 1, priceLineVisible: false });
    const ma60 = chart.addLineSeries({ color: '#B57BFF', lineWidth: 1, priceLineVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    maSeriesRef.current = [ma5, ma20, ma60];

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      maSeriesRef.current = [];
      // 图表重建后需要全量重绘
      renderSigRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || candles.length === 0) return;

    const last = candles[candles.length - 1];
    const lastTime = Math.floor(last.time / 1000) as never;
    const prev = renderSigRef.current;
    const key = `${resetKey ?? ''}:${showMA}`;

    // 数据集被整体替换（首次渲染 / 切换周期 / 长度跳变 / 时间倒退）时全量重绘
    const replaced =
      !prev ||
      candles.length === 0 ||
      last.time < prev.lastTime ||
      Math.abs(candles.length - prev.length) > 1;
    // 切换周期或交易对时才重置缩放，避免增量刷新时把用户的缩放平移位置冲掉
    const resetView = !prev || prev.key !== key;
    const full = replaced || resetView;

    if (full) {
      series.setData(
        candles.map((c) => ({
          time: Math.floor(c.time / 1000) as never,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );

      volumeSeriesRef.current?.setData(
        candles.map((c) => ({
          time: Math.floor(c.time / 1000) as never,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(14,203,129,0.28)' : 'rgba(246,70,93,0.28)',
        })),
      );

      if (showMA) {
        const closes = candles.map((c) => c.close);
        const times = candles.map((c) => Math.floor(c.time / 1000));
        const [ma5, ma20, ma60] = maSeriesRef.current;
        const build = (values: (number | null)[]) =>
          values
            .map((v, i) => (v === null ? null : { time: times[i] as never, value: v }))
            .filter((d): d is { time: never; value: number } => d !== null);

        ma5?.setData(build(sma(closes, 5)));
        ma20?.setData(build(sma(closes, 20)));
        ma60?.setData(build(sma(closes, 60)));
      }

      if (resetView) chartRef.current?.timeScale().fitContent();
    } else {
      // 增量：只推最后一根（原地修改，或跨周期后新增）
      series.update({
        time: lastTime,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      });

      volumeSeriesRef.current?.update({
        time: lastTime,
        value: last.volume,
        color: last.close >= last.open ? 'rgba(14,203,129,0.28)' : 'rgba(246,70,93,0.28)',
      });

      if (showMA) {
        const [ma5, ma20, ma60] = maSeriesRef.current;
        const periods: [ISeriesApi<'Line'> | null, number][] = [
          [ma5 ?? null, 5],
          [ma20 ?? null, 20],
          [ma60 ?? null, 60],
        ];
        for (const [line, period] of periods) {
          const value = maAt(candles, period);
          if (line && value !== null) line.update({ time: lastTime, value });
        }
      }
    }

    renderSigRef.current = { key, length: candles.length, lastTime: last.time };
  }, [candles, showMA, resetKey]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} />
      {showMA ? (
        <div className="pointer-events-none absolute left-3 top-3 flex gap-3 text-[11px]">
          <span style={{ color: '#FFB020' }}>MA5</span>
          <span style={{ color: '#2E90FA' }}>MA20</span>
          <span style={{ color: '#B57BFF' }}>MA60</span>
        </div>
      ) : null}
    </div>
  );
}
