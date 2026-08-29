import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DEFAULT_SYMBOL, WS_EVENT } from '@ai-trader/shared';
import { EventBusService } from '../common/events';
import { MarketService } from '../market/market.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly events: EventBusService,
    private readonly market: MarketService,
  ) {}

  onModuleInit() {
    // 进程内事件统一转成 WebSocket 广播
    this.events.stream$().subscribe((event) => {
      this.server?.emit(WS_EVENT, {
        type: event.type,
        payload: event.payload,
        ts: event.ts,
      });
    });
  }

  afterInit() {
    this.logger.log('WebSocket 网关已启动: /realtime');
  }

  handleConnection(client: Socket) {
    const ticker = this.market.getTicker(DEFAULT_SYMBOL);
    client.emit(WS_EVENT, {
      type: 'price',
      payload: {
        symbol: ticker.symbol,
        price: ticker.price,
        changePercent24h: ticker.changePercent24h,
        ts: Date.now(),
      },
      ts: Date.now(),
    });
  }
}
