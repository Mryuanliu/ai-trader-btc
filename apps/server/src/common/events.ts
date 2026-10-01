import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';
import {
  BasketDirection,
  Candle,
  LotDirection,
  LotExitReason,
  MarketType,
  NewsItemDTO,
  OrderDTO,
  OrderSource,
  PriceTick,
  RunMode,
  Timeframe,
} from '@ai-trader/shared';

/**
 * 进程内事件（网关据此向前端广播）。
 *
 * `decision`（决策产出）与 `risk`（风控事件）已随决策引擎/风控移除——
 * 平台不再产生这两类事件，前端改为直接拉取策略状态。
 */
export interface AppEventMap {
  price: PriceTick;
  candle: { symbol: string; interval: Timeframe; candle: Candle };
  order: OrderDTO;
  news: NewsItemDTO;
  /** 开仓成交（逐 Lot 建仓）：供飞书等外推通知订阅 */
  lotOpened: LotOpenedEvent;
  /** 平仓结算（逐 Lot 结束）：带净盈亏 */
  lotClosed: LotClosedEvent;
  /** 篮子整轮了结：一次建仓→全部平仓的周期汇总 */
  basketClosed: BasketClosedEvent;
  /** 平台侧熔断触发（D4）：实例连亏/回撤达阈被停，持仓保留需人工处理 */
  protectionTripped: ProtectionTrippedEvent;
}

export interface LotOpenedEvent {
  symbol: string;
  market: MarketType;
  direction: LotDirection;
  quantity: number;
  entryPrice: number;
  fee: number;
  strategyInstanceId: string | null;
  source: OrderSource;
  mode: RunMode;
  ts: number;
}

export interface LotClosedEvent {
  symbol: string;
  market: MarketType;
  direction: LotDirection;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  returnPct: number;
  exitReason: LotExitReason;
  strategyInstanceId: string | null;
  basketCode: string | null;
  mode: RunMode;
  ts: number;
}

export interface BasketClosedEvent {
  code: string;
  symbol: string;
  direction: BasketDirection;
  layerCount: number;
  realizedPnl: number;
  returnPct: number | null;
  feeTotal: number;
  fundingFee: number;
  /** 归属的策略运行实例（D4 熔断据此按实例归因；手动/无归属为 null） */
  strategyInstanceId: string | null;
  mode: RunMode;
  ts: number;
}

export interface ProtectionTrippedEvent {
  instanceId: string;
  strategyName: string;
  symbol: string;
  /** 触发原因（连亏 N 笔 / 回撤 X%） */
  reason: string;
  consecutiveLosses: number;
  drawdownPct: number;
  ts: number;
}

export type AppEventType = keyof AppEventMap;

export interface AppEventEnvelope {
  type: AppEventType;
  payload: AppEventMap[AppEventType];
  ts: number;
}

/** 轻量进程内事件总线，供 WebSocket 网关统一定向前端广播 */
@Injectable()
export class EventBusService {
  private readonly subject = new Subject<AppEventEnvelope>();

  emit<K extends AppEventType>(type: K, payload: AppEventMap[K]): void {
    this.subject.next({ type, payload, ts: Date.now() });
  }

  on$<K extends AppEventType>(type: K): Observable<AppEventMap[K]> {
    return this.subject.pipe(
      filter((event) => event.type === type),
      map((event) => event.payload as AppEventMap[K]),
    );
  }

  stream$(): Observable<AppEventEnvelope> {
    return this.subject.asObservable();
  }
}
