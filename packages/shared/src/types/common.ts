/**
 * 支持的交易所。
 *
 * 本项目**只做合约（U 本位永续）交易**，现货交易所（binance / okx）已于
 * 2026-08-31 的「仅合约」重构中移除，故此处只剩 `binance-futures`。
 *
 * 若将来要再加交易所：追加到数组末尾即可，`ExchangeCode` 是穷举联合类型，
 * 所有 `Record<ExchangeCode, ...>` 映射缺项会在编译期报错，不会静默遗漏。
 */
export const EXCHANGE_CODES = ['binance-futures'] as const;
export type ExchangeCode = (typeof EXCHANGE_CODES)[number];

export const EXCHANGE_LABELS: Record<ExchangeCode, string> = {
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

/** 默认市场。仅合约模式下所有新数据都归合约，兜底值随之改为 futures */
export const DEFAULT_MARKET: MarketType = 'futures';

/** 各交易所所属市场：新增交易所或市场只需在此登记 */
export const EXCHANGE_MARKETS: Record<ExchangeCode, MarketType> = {
  'binance-futures': 'futures',
};

export function marketOfExchange(code: ExchangeCode): MarketType {
  return EXCHANGE_MARKETS[code] ?? DEFAULT_MARKET;
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
/**
 * 订单类型。
 *
 * `STOP_MARKET`：条件市价单——BUY 在价格**上破** stopPrice 时成交，
 * SELL 在价格**下破**时成交（即 MT5 的 BuyStop / SellStop）。
 * 策略的网格待成交层用它实现，触发由交易所负责，平台不轮询。
 */
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';

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
/**
 * 订单来源。
 * - `strategy`：策略自动下单（当前唯一的自动来源）
 * - `manual`：用户在面板手动下单
 * - `agent`：历史遗留（旧决策引擎），仅存量数据中存在
 */
export type OrderSource = 'agent' | 'manual' | 'strategy';

export const DEFAULT_SYMBOL = 'BTCUSDT';
export const QUOTE_ASSET = 'USDT';
export const BASE_ASSET = 'BTC';
