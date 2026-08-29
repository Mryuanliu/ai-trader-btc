import { useEffect } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from '@/router';
import { antdTheme } from '@/theme';
import { useRealtimeStore } from '@/ws/realtime';
import { configureAuth } from '@/api/client';
import { getToken, useAuthStore } from '@/store/auth';
import '@/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

configureAuth({
  getToken,
  onUnauthorized: () => useAuthStore.getState().clear(),
});

export default function App() {
  const connect = useRealtimeStore((s) => s.connect);
  const disconnect = useRealtimeStore((s) => s.disconnect);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN} theme={antdTheme}>
        <AntApp>
          <div className="app-backdrop" />
          <div className="relative z-10">
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </div>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
