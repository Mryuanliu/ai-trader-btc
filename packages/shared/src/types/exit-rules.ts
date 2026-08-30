import type { DecisionAction } from './common';
import type { ExitRulesShape } from './agent';
import type { PositionSide } from './futures';

/**
 * 方向感知的持仓盈亏比例。
 *
 * 多头：价格上涨盈利；空头：价格下跌盈利。
 * 现货只有多头（side 传 null 等价 LONG），合约必须传方向，
 * 否则空头的止盈止损会反向触发——亏损时不但不平仓，还会继续持有。
 */
export function computePnlPct(
  entryPrice: number,
  price: number,
  side: PositionSide | null,
): number {
  if (!(entryPrice > 0)) return 0;
  // 空头：盈亏随价格反向变动
  return side === 'SHORT' ? (entryPrice - price) / entryPrice : (price - entryPrice) / entryPrice;
}

export interface ExitEvaluationInput {
  /** 持仓均价（现货）/ 开仓均价（合约） */
  entryPrice: number;
  /** 当前价格 */
  price: number;
  /** 持仓方向；现货传 null（按多头处理） */
  side: PositionSide | null;
  exitRules: ExitRulesShape;
}

export interface ExitEvaluationResult {
  triggered: boolean;
  /** 触发类型，未触发时为 null */
  kind: 'stopLoss' | 'takeProfit' | null;
  /** 平仓动作：多头平仓=SELL，空头平仓=BUY */
  closeAction: DecisionAction | null;
  pnlPct: number;
  /** 人类可读的触发说明，用于决策记录与告警 */
  reason: string;
}

/**
 * 出场规则判定（止损 / 止盈），现货与合约共用。
 *
 * 差异全部收敛在两点：盈亏比例按方向翻转、平仓动作按方向取反。
 * 其余（阈值比较、文案、优先级）两市场完全一致。
 *
 * 默认全关（exitRules 两项均为 null）时直接返回未触发，不参与决策。
 */
export function evaluateExitRules(input: ExitEvaluationInput): ExitEvaluationResult {
  const { entryPrice, price, side, exitRules } = input;
  const { stopLossPct, takeProfitPct } = exitRules ?? {};

  const pnlPct = computePnlPct(entryPrice, price, side);
  // 平仓动作：多头平仓要卖出，空头平仓要买入
  const closeAction: DecisionAction = side === 'SHORT' ? 'BUY' : 'SELL';

  const untriggered: ExitEvaluationResult = {
    triggered: false,
    kind: null,
    closeAction: null,
    pnlPct,
    reason: '',
  };

  if (stopLossPct == null && takeProfitPct == null) return untriggered;
  if (!(price > 0) || !(entryPrice > 0)) return untriggered;

  const sideLabel = side === 'SHORT' ? '空头' : '多头';
  const pnlText = `${(pnlPct * 100).toFixed(2)}%`;

  if (stopLossPct != null && pnlPct <= -stopLossPct) {
    return {
      triggered: true,
      kind: 'stopLoss',
      closeAction,
      pnlPct,
      reason:
        `止损触发：${sideLabel}现价 ${price.toFixed(2)} 较开仓均价 ${entryPrice.toFixed(2)} ` +
        `亏损 ${pnlText}，达到 -${(stopLossPct * 100).toFixed(2)}% 阈值`,
    };
  }

  if (takeProfitPct != null && pnlPct >= takeProfitPct) {
    return {
      triggered: true,
      kind: 'takeProfit',
      closeAction,
      pnlPct,
      reason:
        `止盈触发：${sideLabel}现价 ${price.toFixed(2)} 较开仓均价 ${entryPrice.toFixed(2)} ` +
        `盈利 ${pnlText}，达到 +${(takeProfitPct * 100).toFixed(2)}% 阈值`,
    };
  }

  return untriggered;
}
