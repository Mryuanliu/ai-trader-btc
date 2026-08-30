/**
 * 支持的交易所。
 *
 * `binance-futures` 是币安 U 本位合约，与现货 `binance` 是两套独立账户与链路，
 * 但共用同一套 API Key（demo 环境已实测通用）。
 *
 * 注意追加顺序：多处循环是「首个可用即返回」的短路逻辑，
 * 新增交易所请**追加到数组末尾**，避免抢占现货链路的默认选择。
 */
export const EXCHANGE_CODES = ['binance', 'okx', 'binance-futures'] as const;
export type ExchangeCode = (typeof EXCHANGE_CODES)[number];

export const EXCHANGE_LABELS: Record<ExchangeCode, string> = {
  binance: '币安 Binance',
  okx: '欧意 OKX',
  'binance-futures': '币安合约',
};

/**
 * 市场类型：现货 / 合约（U 本位永续）。
 * 系统按此维度隔离 K 线、执行、风控与持仓（L4~L6），而指标与策略层（L0~L3）完全共用。
 */
export const MARKETS = ['spot', 'futures'] as const;
export type MarketType = (typeof MARKETS)[number];

export const MARKET_LABELS: Record<MarketType, string> = {
  spot: '现货',
  futures: '合约',
};

export const DEFAULT_MARKET: MarketType = 'spot';

/** 各交易所所属市场：新增交易所或市场只需在此登记 */
export const EXCHANGE_MARKETS: Record<ExchangeCode, MarketType> = {
  binance: 'spot',
  okx: 'spot',
  'binance-futures': 'futures',
};

/**
 * 现货交易所集合。
 *
 * 现货行情拉取、余额读取、Agent 可选交易所等处必须用它而非 EXCHANGE_CODES：
 * 遍历全部交易所会把合约账户也纳进来，导致合约钱包余额与现货 USDT 重复计入总权益。
 */
export const SPOT_EXCHANGE_CODES = ['binance', 'okx'] as const;

export function marketOfExchange(code: ExchangeCode): MarketType {
  return EXCHANGE_MARKETS[code] ?? DEFAULT_MARKET;
}

export function isSpotExchange(code: ExchangeCode): boolean {
  return marketOfExchange(code) === 'spot';
}

/**
 * 合约最小名义价值的**保守兜底值**（USDT），仅在 exchangeInfo 取不到过滤器时使用。
 *
 * 真实门槛由交易所按标的下发且各不相同（实测合约 demo：BTCUSDT=50、ETHUSDT=20、多数=5），
 * 一律优先以 `getSymbolFilters()` 返回的 minNotional 为准。
 * 兜底取偏大的值更安全：宁可少下单，也不要发一个被交易所 -4164 拒绝的单。
 */
export const FUTURES_MIN_NOTIONAL = 100;

/**
 * 账户环境：模拟盘（币安 Demo Mode） / 测试网 / 实盘
 * 三者在数据库 exchange_accounts.environment 列中以字符串存储
 */
export const ENVIRONMENTS = ['demo', 'testnet', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  demo: '模拟盘',
  testnet: '测试网',
  live: '实盘',
};

/**
 * 运行模式：dry_run 只落库不真实发单
 * testnet / live 会真实发单到账户环境对应的主机
 */
export const RUN_MODES = ['dry_run', 'testnet', 'live'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_MODE_LABELS: Record<RunMode, string> = {
  dry_run: '模拟撮合',
  testnet: '测试网',
  live: '实盘',
};

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

export const ORDER_STATUSES = [
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: '待成交',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '已成交',
  CANCELED: '已撤销',
  REJECTED: '已拒绝',
  EXPIRED: '已过期',
  FAILED: '失败',
};

/** 是否为未终结状态 */
export function isOpenStatus(status: OrderStatus): boolean {
  return status === 'NEW' || status === 'PARTIALLY_FILLED';
}

/** 已终结且未成交任何数量的状态，不应计入今日下单笔数等风控口径 */
export const TERMINAL_EMPTY_STATUSES = ['CANCELED', 'REJECTED', 'EXPIRED', 'FAILED'] as const;

/**
 * 交易所交易对过滤器，来自 exchangeInfo / instruments，按 symbol 缓存。
 *
 * 交易所会按 stepSize 校验数量、按 tickSize 校验价格、按 minNotional 校验名义价值，
 * 任一项不满足都会直接拒单（币安 -1013 / -1111 / -4164）。
 */
export interface SymbolFilters {
  symbol: string;
  /** 数量步进，下单量需向下取整到其整数倍 */
  stepSize: number;
  /** 价格步进，限价单价格需取整到其整数倍 */
  tickSize: number;
  minQty: number;
  maxQty: number;
  /** 最小名义价值，以 quote 资产计价 */
  minNotional: number;
}

/** 过滤器不可用时的兜底值，仅保证能发出合法请求，不代表交易所真实限制 */
export const FALLBACK_SYMBOL_FILTERS: Omit<SymbolFilters, 'symbol'> = {
  stepSize: 0.00001,
  tickSize: 0.01,
  minQty: 0.00001,
  maxQty: 9_000_000,
  minNotional: 5,
};

/**
 * 风控参数安全边界。
 *
 * 风控各项原本以 `> 0` 作为启用判据，配置置 0 即等于关闭该规则。
 * 这里改为下界钳制：置 0 会回落到 min 而非失效，避免误配置导致裸奔。
 */
export const RISK_LIMITS = {
  maxOrderAmount: { min: 1, max: 1_000_000 },
  maxDailyOrders: { min: 1, max: 1_000 },
  maxDrawdownPct: { min: 0.1, max: 100 },
  minOrderIntervalSec: { min: 0, max: 86_400 },
  dailyLossLimit: { min: 1, max: 1_000_000 },
  positionPct: { min: 0.0001, max: 1 },
  minConfidence: { min: 0, max: 1 },
  /** 模拟撮合滑点，单位 bps（1bps = 0.01%） */
  slippageBps: { min: 0, max: 100 },
  /** 手续费率，单位 bps，默认 10bps（0.1%） */
  feeRateBps: { min: 0, max: 100 },
  /** 单一标的持仓市值占总权益的上限（百分比），防止连续加仓导致过度集中 */
  maxExposurePct: { min: 5, max: 100 },
  /** 合约开仓杠杆倍数。上限 10：再高则小幅波动即强平，与「回撤优先」原则冲突 */
  leverage: { min: 1, max: 10 },
  /** 杠杆硬上限（管理员可下调，但不允许配出超过此值的天花板） */
  maxLeverage: { min: 1, max: 20 },
  /** 距强平价低于该比例时禁止加仓（0.15 = 15%） */
  liquidationBufferPct: { min: 0.01, max: 0.5 },
} as const;

/** 由成交明细推导的持仓快照 */
export interface PositionSnapshot {
  symbol: string;
  /** 净持仓数量 */
  quantity: number;
  /** 加权平均成本价（买入侧，含手续费摊薄） */
  avgCost: number;
  /** 已实现盈亏（卖出时兑现，已扣手续费） */
  realizedPnl: number;
  /** 未实现盈亏，按当前价计算 */
  unrealizedPnl: number;
  /** 持仓市值 = quantity × 当前价 */
  marketValue: number;
  /** 累计买入数量 */
  totalBought: number;
  /** 累计卖出数量 */
  totalSold: number;
  /** 累计手续费 */
  totalFee: number;
}

/**
 * 合约持仓快照：净持仓可正可负，以交易所 positionRisk 为权威（不落库推导）。
 *
 * 与现货 PositionSnapshot 的关键差异：
 * - quantity 可为负（空头），现货恒为非负
 * - 有强平价与保证金概念，现货无
 * - 名义价值 = |quantity| × markPrice，而非 quantity × price
 */
export interface FuturesPositionSnapshot {
  symbol: string;
  /** 净持仓数量：正=多头，负=空头，0=无持仓 */
  quantity: number;
  entryPrice: number;
  markPrice: number;
  /** 强平价；无持仓或无强平风险时交易所返回 0 */
  liquidationPrice: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  /** 逐仓模式下该仓位的保证金；全仓模式下为 0 */
  isolatedMargin: number;
  unrealizedPnl: number;
  /** 名义价值 = |quantity| × markPrice */
  notional: number;
  /**
   * 距强平价的百分比（方向感知：多头看下跌空间，空头看上涨空间）。
   * 无持仓或强平价为 0 时为 null，表示无强平风险。
   */
  liquidationDistancePct: number | null;
}

export type RiskLimitKey = keyof typeof RISK_LIMITS;

/** 把数值钳制到合法区间；非有限值或非数字时回落到 min */
export function clampRiskValue(key: RiskLimitKey, value: unknown): number {
  const { min, max } = RISK_LIMITS[key];
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 浮点安全的小数位数推断。
 * 0.01 -> 2；0.00001 -> 5；1 -> 0。
 *
 * 不能基于 toFixed(20) 去尾零：0.1.toFixed(20) 会暴露二进制表示的误差尾数
 * （"0.10000000000000000555"），导致推断出的位数远大于真实值。
 * 这里改用逐步放大并检查是否落在整数上，最多支持 12 位小数。
 */
export function precisionOf(step: number): number {
  if (!(step > 0)) return 0;
  if (Number.isInteger(step)) return 0;
  for (let p = 1; p <= 12; p += 1) {
    const scaled = step * 10 ** p;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return p;
  }
  return 12;
}

/**
 * 相对误差补偿。
 * 大比例除法会引入浮点误差：9000/0.00001 = 899999999.9999999，
 * 直接 floor 会错误地退一档得到 8999.99999。因此按比例大小缩放补偿量。
 */
function stepEpsilon(ratio: number): number {
  return Math.max(1e-9, Math.abs(ratio) * 1e-12);
}

/** 按步进向下取整（买入方向用，避免超出可用余额） */
export function floorToStep(value: number, step: number): number {
  if (!(value > 0) || !(step > 0)) return 0;
  const digits = precisionOf(step);
  const ratio = value / step;
  const scaled = Math.floor(ratio + stepEpsilon(ratio)) * step;
  return Number(scaled.toFixed(Math.min(digits, 12)));
}

/** 按步进就近取整（价格用） */
export function roundToStep(value: number, step: number): number {
  if (!(value > 0) || !(step > 0)) return 0;
  const digits = precisionOf(step);
  const ratio = value / step;
  const scaled = Math.round(ratio + stepEpsilon(ratio)) * step;
  return Number(scaled.toFixed(Math.min(digits, 12)));
}

export type DecisionAction = 'BUY' | 'SELL' | 'HOLD';

export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  BUY: '买入',
  SELL: '卖出',
  HOLD: '观望',
};

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '1m': '1 分钟',
  '5m': '5 分钟',
  '15m': '15 分钟',
  '1h': '1 小时',
  '4h': '4 小时',
  '1d': '1 天',
};

/** 订单来源 */
export type OrderSource = 'agent' | 'manual';

export const DEFAULT_SYMBOL = 'BTCUSDT';
export const QUOTE_ASSET = 'USDT';
export const BASE_ASSET = 'BTC';
