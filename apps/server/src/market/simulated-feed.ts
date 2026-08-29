import { Candle, TIMEFRAME_MS, Timeframe } from '@ai-trader/shared';

/** 确定性伪随机，保证重启后模拟曲线不至于完全跳变 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MINUTE_VOL = 0.0012; // 每分钟波动率，约合日波动 4~5%

/**
 * 模拟行情源：外部交易所不可达时的降级方案
 * 生成拟真的多周期 K 线，并按秒推进最新价格
 */
export class SimulatedFeed {
  private readonly rand: () => number;
  private price: number;
  private readonly baseVolume: number;

  constructor(
    private readonly symbol: string,
    seed = 20260101,
    startPrice = 68000,
  ) {
    this.rand = mulberry32(seed);
    this.price = startPrice;
    this.baseVolume = 12 + this.rand() * 6;
  }

  get currentPrice(): number {
    return this.price;
  }

  /** 生成 count 根历史 K 线，最后一根收盘价等于当前价 */
  buildHistory(interval: Timeframe, count: number): Candle[] {
    const stepMs = TIMEFRAME_MS[interval];
    const steps = Math.max(1, Math.round(stepMs / 60_000));
    const sigma = MINUTE_VOL * Math.sqrt(steps);
    const now = Date.now();
    const currentOpenTime = Math.floor(now / stepMs) * stepMs;

    // 先从起点正向走到倒数第二根，再让最后一根收在当前价
    const closes: number[] = [];
    let p = this.price * (1 - sigma * Math.sqrt(count) * 0.35);
    for (let i = 0; i < count - 1; i += 1) {
      p = p * (1 + gaussian(this.rand) * sigma);
      closes.push(p);
    }
    closes.push(this.price);

    const candles: Candle[] = [];
    for (let i = 0; i < count; i += 1) {
      const openTime = currentOpenTime - (count - 1 - i) * stepMs;
      const open = i === 0 ? closes[0] * (1 - sigma * 0.2) : closes[i - 1];
      const close = closes[i];
      const wick = Math.abs(close - open) + close * sigma * (0.4 + this.rand() * 0.8);
      const high = Math.max(open, close) + wick * this.rand();
      const low = Math.min(open, close) - wick * this.rand();
      const volume = this.baseVolume * steps * (0.6 + this.rand() * 0.9);
      candles.push({
        time: openTime,
        open: round(open),
        high: round(high),
        low: round(Math.max(low, 1)),
        close: round(close),
        volume: round(volume, 4),
      });
    }
    return candles;
  }

  /** 推进一个 tick，返回最新价 */
  tick(): number {
    const drift = gaussian(this.rand) * MINUTE_VOL * 0.35;
    this.price = Math.max(1000, this.price * (1 + drift));
    return this.price;
  }

  /** 把最新价应用到某周期的当前 K 线上；返回可能新开的 K 线 */
  applyTick(price: number, candles: Candle[], interval: Timeframe): { candle: Candle; isNew: boolean } {
    const stepMs = TIMEFRAME_MS[interval];
    const openTime = Math.floor(Date.now() / stepMs) * stepMs;
    const last = candles[candles.length - 1];
    if (!last) {
      const candle: Candle = {
        time: openTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: this.baseVolume,
      };
      candles.push(candle);
      return { candle, isNew: true };
    }

    if (openTime > last.time) {
      const candle: Candle = {
        time: openTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: this.baseVolume * (0.5 + this.rand()),
      };
      candles.push(candle);
      return { candle, isNew: true };
    }

    last.close = round(price);
    last.high = round(Math.max(last.high, price));
    last.low = round(Math.min(last.low, price));
    last.volume = round(last.volume + this.baseVolume * 0.02, 4);
    return { candle: last, isNew: false };
  }
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
