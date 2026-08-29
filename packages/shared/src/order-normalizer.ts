import {
  FALLBACK_SYMBOL_FILTERS,
  SymbolFilters,
  floorToStep,
  roundToStep,
} from './types/common';

/** 规整结果：合法时返回可直接下单的参数，否则给出具体拒绝原因 */
export type NormalizeResult =
  | {
      ok: true;
      quantity: number;
      price?: number;
      quoteAmount: number;
      /** 是否因取整而调整过，便于日志与决策记录追溯 */
      adjusted: boolean;
    }
  | { ok: false; code: string; note: string };

export interface NormalizeInput {
  /** 期望下单数量（未取整） */
  quantity: number;
  /** 用于计算名义价值的参考价；市价单传当前价 */
  price: number;
  filters: SymbolFilters;
  /** 限价单需要按 tickSize 取整价格 */
  type?: 'MARKET' | 'LIMIT';
}

/**
 * 把下单参数规整到交易所可接受的精度，并校验最小名义价值。
 *
 * exchangeInfo 不可达时回落到 FALLBACK_SYMBOL_FILTERS，
 * 保证不会因过滤器获取失败而完全无法下单（仍可能被交易所拒绝，但错误可诊断）。
 */
export function normalizeOrder(input: NormalizeInput): NormalizeResult {
  const { filters } = input;
  const stepSize = filters.stepSize > 0 ? filters.stepSize : FALLBACK_SYMBOL_FILTERS.stepSize;
  const tickSize = filters.tickSize > 0 ? filters.tickSize : FALLBACK_SYMBOL_FILTERS.tickSize;
  const minQty = filters.minQty > 0 ? filters.minQty : FALLBACK_SYMBOL_FILTERS.minQty;
  const maxQty = filters.maxQty > 0 ? filters.maxQty : FALLBACK_SYMBOL_FILTERS.maxQty;
  const minNotional =
    filters.minNotional > 0 ? filters.minNotional : FALLBACK_SYMBOL_FILTERS.minNotional;

  if (!(input.price > 0)) {
    return { ok: false, code: 'INVALID_PRICE', note: `价格非法：${input.price}` };
  }

  // 数量向下取整，确保不会超出可用余额
  let quantity = floorToStep(input.quantity, stepSize);
  if (!(quantity > 0)) {
    return {
      ok: false,
      code: 'QUANTITY_BELOW_STEP',
      note: `下单量 ${input.quantity} 小于最小步进 ${stepSize}，取整后为 0`,
    };
  }

  if (quantity < minQty) {
    return {
      ok: false,
      code: 'QUANTITY_BELOW_MIN',
      note: `下单量 ${quantity} 小于交易所最小数量 ${minQty}`,
    };
  }

  if (quantity > maxQty) {
    quantity = floorToStep(maxQty, stepSize);
  }

  let price = input.price;
  if (input.type === 'LIMIT') {
    price = roundToStep(price, tickSize);
    if (!(price > 0)) {
      return { ok: false, code: 'INVALID_PRICE', note: `限价取整后非法：${input.price}` };
    }
  }

  const quoteAmount = quantity * price;
  if (quoteAmount < minNotional) {
    return {
      ok: false,
      code: 'BELOW_MIN_NOTIONAL',
      note: `名义价值 ${quoteAmount.toFixed(2)} 低于交易所最小 ${minNotional}，需提高仓位比例`,
    };
  }

  return {
    ok: true,
    quantity,
    price: input.type === 'LIMIT' ? price : undefined,
    quoteAmount,
    adjusted: quantity !== input.quantity || price !== input.price,
  };
}
