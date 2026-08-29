import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import {
  WS_EVENT,
  type DecisionSummary,
  type NewsItemDTO,
  type OrderDTO,
  type PriceTick,
} from '@ai-trader/shared';

export interface RiskNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
}

interface RealtimeState {
  connected: boolean;
  price: PriceTick | null;
  lastOrder: OrderDTO | null;
  lastDecision: DecisionSummary | null;
  riskNotices: RiskNotice[];
  latestNews: NewsItemDTO | null;
  connect: () => void;
  disconnect: () => void;
}

let socket: Socket | null = null;

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  price: null,
  lastOrder: null,
  lastDecision: null,
  riskNotices: [],
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
        case 'decision':
          set({ lastDecision: event.payload as DecisionSummary });
          break;
        case 'news':
          set({ latestNews: event.payload as NewsItemDTO });
          break;
        case 'risk':
          set((state) => ({
            riskNotices: [event.payload as RiskNotice, ...state.riskNotices].slice(0, 30),
          }));
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
