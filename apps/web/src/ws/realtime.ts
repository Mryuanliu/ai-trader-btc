import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import { WS_EVENT, type NewsItemDTO, type OrderDTO, type PriceTick } from '@ai-trader/shared';

/**
 * 实时推送状态。
 *
 * 已移除 `decision`（决策产出）与 `risk`（风控事件）：
 * 平台不再产生这两类事件，策略状态改由 `/strategy/status` 轮询获取。
 */
interface RealtimeState {
  connected: boolean;
  price: PriceTick | null;
  lastOrder: OrderDTO | null;
  latestNews: NewsItemDTO | null;
  connect: () => void;
  disconnect: () => void;
}

let socket: Socket | null = null;

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  price: null,
  lastOrder: null,
  latestNews: null,

  connect: () => {
    if (socket) return;
    socket = io('/realtime', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => set({ connected: true }));
    socket.on('disconnect', () => set({ connected: false }));

    socket.on(WS_EVENT, (event: { type: string; payload: unknown }) => {
      switch (event.type) {
        case 'price':
          set({ price: event.payload as PriceTick });
          break;
        case 'order':
          set({ lastOrder: event.payload as OrderDTO });
          break;
        case 'news':
          set({ latestNews: event.payload as NewsItemDTO });
          break;
        default:
          break;
      }
    });
  },

  disconnect: () => {
    socket?.close();
    socket = null;
    set({ connected: false });
  },
}));
