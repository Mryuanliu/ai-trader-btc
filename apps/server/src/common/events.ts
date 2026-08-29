import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';
import { Candle, NewsItemDTO, PriceTick, Timeframe } from '@ai-trader/shared';
import { DecisionSummary, OrderDTO } from '@ai-trader/shared';
import { RiskLevel } from '../database/entities';

export interface AppEventMap {
  price: PriceTick;
  candle: { symbol: string; interval: Timeframe; candle: Candle };
  order: OrderDTO;
  decision: DecisionSummary;
  risk: { level: RiskLevel; message: string; ts: number };
  news: NewsItemDTO;
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
