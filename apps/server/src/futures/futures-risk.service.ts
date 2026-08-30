import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  clampRiskValue,
  FuturesAgentConfigShape,
  FuturesOrderIntent,
  FUTURES_RISK_REASONS,
} from '@ai-trader/shared';
import { Repository } from 'typeorm';
import { RiskEventEntity, RiskLevel } from '../database/entities';

export interface FuturesRiskContext {
  config: FuturesAgentConfigShape;
  symbol: string;
  intent: FuturesOrderIntent;
  /** 下单数量（已按交易所步进取整） */
  quantity: number;
  /** 参考价格 */
  price: number;
  /** 名义价值 = quantity × price */
  notional: number;
  /** 本次开仓将占用的保证金 */
  margin: number;
  /** 合约账户可用保证金 */
  availableMargin: number;
  /** 当前该标的持仓（用于强平距离校验） */
  currentPosition: {
    quantity: number;
    liquidationDistancePct: number | null;
  } | null;
  /** 交易所最小名义价值 */
  minNotional: number;
  source: 'agent' | 'manual';
  confirmToken?: string;
  liveConfirmToken: string;
}

export interface FuturesRiskVerdict {
  passed: boolean;
  rejectedBy?: string;
  note?: string;
}

/**
 * 合约风控：在现货风控之外追加合约专属约束。
 *
 * 与现货风控刻意不共用：现货看「余额够不够」，合约看「保证金够不够、
 * 杠杆是否越界、距强平还有多远」，判定口径完全不同，混在一起会让双方都失真。
 */
@Injectable()
export class FuturesRiskService {
  private readonly logger = new Logger(FuturesRiskService.name);

  constructor(
    @InjectRepository(RiskEventEntity)
    private readonly riskRepo: Repository<RiskEventEntity>,
  ) {}

  /** 所有合约下单（含手动单）统一经过此守卫 */
  async check(ctx: FuturesRiskContext): Promise<FuturesRiskVerdict> {
    const { config, intent } = ctx;

    if (intent.kind === 'hold') {
      return { passed: false, rejectedBy: 'HOLD', note: '策略观望，不产生订单' };
    }

    if (!(ctx.quantity > 0)) {
      return this.reject(ctx, 'INVALID_QUANTITY', `下单数量非法：${ctx.quantity}`);
    }

    // 平仓单不需要保证金与强平校验：它只会释放保证金、降低风险
    const isClose = intent.kind === 'close';

    if (config.mode === 'live') {
      if (!ctx.confirmToken || ctx.confirmToken !== ctx.liveConfirmToken) {
        return this.reject(
          ctx,
          'LIVE_MODE_CONFIRM_REQUIRED',
          '实盘模式需要携带正确的二次确认 Token',
        );
      }
    }

    // 杠杆钳制：配置值、硬上限双重约束，防止调低 maxLeverage 后存量配置越界
    const effectiveLeverage = clampLeverage(config.leverage, config.maxLeverage);
    if (effectiveLeverage !== config.leverage) {
      this.logger.warn(
        `杠杆被钳制: 配置 ${config.leverage} -> ${effectiveLeverage}（硬上限 ${config.maxLeverage}）`,
      );
    }

    if (isClose) {
      // 平仓还需确认确实有仓位可平，否则 reduceOnly 单会被交易所拒绝
      if (!ctx.currentPosition || Math.abs(ctx.currentPosition.quantity) <= 0) {
        return this.reject(ctx, 'NO_POSITION_TO_CLOSE', `${ctx.symbol} 当前无持仓，无法只平仓`);
      }
      return { passed: true, note: '平仓单校验通过' };
    }

    // ---- 开仓/加仓：以下校验仅对增加风险的订单生效 ----

    if (ctx.notional < ctx.minNotional) {
      return this.reject(
        ctx,
        'BELOW_MIN_NOTIONAL',
        `名义价值 ${ctx.notional.toFixed(2)} 低于交易所最小 ${ctx.minNotional}，` +
          `需提高仓位比例或杠杆`,
      );
    }

    if (ctx.margin > ctx.availableMargin) {
      return this.reject(
        ctx,
        'INSUFFICIENT_MARGIN',
        `需占用保证金 ${ctx.margin.toFixed(2)}，可用仅 ${ctx.availableMargin.toFixed(2)}`,
      );
    }

    // 距强平价过近时禁止加仓：此时再开仓等同于主动走向爆仓
    if (ctx.currentPosition && Math.abs(ctx.currentPosition.quantity) > 0) {
      const distance = ctx.currentPosition.liquidationDistancePct;
      const buffer = clampRiskValue('liquidationBufferPct', config.liquidationBufferPct);
      if (distance !== null && distance < buffer) {
        return this.reject(
          ctx,
          'LIQUIDATION_TOO_CLOSE',
          `距强平价仅 ${(distance * 100).toFixed(2)}%，低于安全缓冲 ${(buffer * 100).toFixed(0)}%，` +
            `禁止加仓`,
        );
      }
    }

    return { passed: true, note: `合约风控校验通过（杠杆 ${effectiveLeverage}x）` };
  }

  /** 计算实际生效杠杆：先按 RISK_LIMITS 钳制，再受 maxLeverage 天花板约束 */
  effectiveLeverage(config: FuturesAgentConfigShape): number {
    return clampLeverage(config.leverage, config.maxLeverage);
  }

  private async reject(
    ctx: FuturesRiskContext,
    code: string,
    note: string,
  ): Promise<FuturesRiskVerdict> {
    const reason = FUTURES_RISK_REASONS[code] ?? code;
    this.logger.warn(`[合约风控拦截][${code}] ${ctx.symbol} - ${note}`);
    await this.record('limit', 'warn', `${reason}：${note}`, ctx.symbol);
    return { passed: false, rejectedBy: code, note: `${reason}：${note}` };
  }

  async record(
    type: string,
    level: RiskLevel,
    message: string,
    symbol = '',
    decisionId: string | null = null,
    meta: Record<string, unknown> | null = null,
  ): Promise<RiskEventEntity> {
    return this.riskRepo.save(
      this.riskRepo.create({ type, level, message, symbol, decisionId, meta }),
    );
  }
}

/**
 * 杠杆钳制：下界 1，上界取「RISK_LIMITS 硬上限」与「配置 maxLeverage」二者较小值。
 *
 * 双重约束的必要性：只钳 leverage 的话，管理员把 maxLeverage 从 10 下调到 3 之后，
 * 存量 leverage=10 仍然越界生效；两个值都必须参与比较。
 */
export function clampLeverage(leverage: number, maxLeverage: number): number {
  const requested = Math.max(1, Math.round(leverage) || 1);
  const ceiling = Math.min(
    clampRiskValue('leverage', requested),
    Math.max(1, Math.round(clampRiskValue('maxLeverage', maxLeverage))),
  );
  return Math.min(requested, ceiling);
}
