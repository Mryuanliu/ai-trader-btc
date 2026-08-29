import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  username: string | null;
  setAuth: (token: string, username: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      username: null,
      setAuth: (token, username) => set({ token, username }),
      clear: () => set({ token: null, username: null }),
    }),
    { name: 'ai-trader-auth' },
  ),
);

export const getToken = () => useAuthStore.getState().token;
