import type { MarketType, Timeframe } from './types/common';
import type { LotDirection } from './position';

/**
 * 策略 SDK 契约（对外）。
 *
 * 这是**策略作者需要遵守的公开契约**，独立于任何内部实现：
 * - `TradingStrategy` = 运行时契约（策略怎么跑）
 * - `StrategyManifest` = 上架元信息（谁写的、要什么数据、有什么风险）
 *
 * 放在 shared 而不是 server 内部，是为了让第三方策略作者
 * 只依赖 `@ai-trader/shared` 这一个包就能写完整个策略。
 */
export interface TradingStrategyContract {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly defaultParams: Record<string, unknown>;
  readonly paramSchema: Record<string, unknown>;
  readonly manifest?: StrategyManifest;
}

/**
 * 策略能力声明：告诉平台「我需要什么、我会做什么」。
 *
 * 平台据此决定推送哪些周期的 K 线、是否允许运行、如何描述风险。
 */
export interface StrategyCapabilities {
  /** 需要的 K 线周期（平台只提供声明过的，省算力） */
  timeframes: Timeframe[];
  /** 是否需要逐笔报价（false 时只用 K 线收盘价） */
  needsTicker: boolean;
  /** 支持的市场（当前平台仅 futures） */
  markets: MarketType[];
  /**
   * 是否会**自动平仓**。
   *
   * 用途：告知用户「这个策略会自己了结仓位」，
   * 与「停止策略后持仓保留」形成对照——避免用户误以为平台兜底。
   */
  autoExit: boolean;
  /** 建议最大层数（仅展示，平台不做风控） */
  suggestedMaxLayers?: number;
}

/** 策略支持的持仓方向（供能力声明与校验用） */
export type StrategySide = LotDirection;

/**
 * 策略清单：上架所需的元信息。
 *
 * `riskNotes` 是**必填**——平台不做风控，但必须把风险讲清楚（告知而非拦截）。
 */
export interface StrategyManifest {
  /** 语义化版本，用于兼容性与升级提示 */
  version: string;
  /** 作者 / 来源 */
  author: string;
  capabilities: StrategyCapabilities;
  /** 风险提示（上架页必读） */
  riskNotes: string[];
}
