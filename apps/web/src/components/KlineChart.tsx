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

export function KlineChart({ candles, height = 320, showMA = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

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
    };
  }, []);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || candles.length === 0) return;

    const data = candles.map((c) => ({
      time: Math.floor(c.time / 1000) as never,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    series.setData(data);

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

    chartRef.current?.timeScale().fitContent();
  }, [candles, showMA]);

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
