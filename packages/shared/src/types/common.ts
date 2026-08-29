/** 支持的交易所 */
export const EXCHANGE_CODES = ['binance', 'okx'] as const;
export type ExchangeCode = (typeof EXCHANGE_CODES)[number];

export const EXCHANGE_LABELS: Record<ExchangeCode, string> = {
  binance: '币安 Binance',
  okx: '欧意 OKX',
};

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
