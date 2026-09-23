import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { LayoutGrid, LineChart, Bot } from 'lucide-react';
import { useOverview } from '@/api/hooks';
import { useRealtimeStore } from '@/ws/realtime';
import { PriceTicker } from '@/components/PriceTicker';
import { EnvBadge, LivePulse } from '@/components/StatusBits';
import { LogoutButton, useRequireAuth } from '@/components/AuthGate';

/** 移动端底部导航：资产 / 交易 / 策略（订单页与决策页已随架构调整移除） */
const TABS = [
  { key: '/m', label: '资产', icon: LayoutGrid },
  { key: '/m/trade', label: '交易', icon: LineChart },
  { key: '/m/strategy', label: '策略', icon: Bot },
];

export function MobileLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useOverview();
  const livePrice = useRealtimeStore((s) => s.price);
  const connected = useRealtimeStore((s) => s.connected);
  const { modal } = useRequireAuth();

  useEffect(() => {
    if (!data?.ticker) return;
    document.title = `AI Trader · ${data.ticker.price.toFixed(2)}`;
  }, [data?.ticker?.price]);

  const price = livePrice?.price ?? data?.ticker?.price ?? 0;
  const change = livePrice?.changePercent24h ?? data?.ticker?.changePercent24h ?? 0;

  return (
    <div className="relative flex min-h-screen flex-col">
      {/* 顶部固定价格条 */}
      <header className="fixed inset-x-0 top-0 z-30 border-b border-white/[0.06] bg-ink-900/85 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3">
          <PriceTicker price={price} changePercent={change} symbol="BTC / USDT" size="sm" />
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {data ? <EnvBadge mode={data.mode} /> : null}
              <LogoutButton />
            </div>
            <button
              onClick={() => navigate('/admin')}
              className="text-[11px] text-muted underline-offset-2 hover:text-btc-light hover:underline"
            >
              切换后台
            </button>
          </div>
        </div>
        <div className="mt-2">
          <LivePulse ok={connected} text={connected ? '实时推送已连接' : '实时推送未连接'} />
        </div>
      </header>

      {/* 内容区，留出顶部导航高度 */}
      <main className="relative z-10 flex-1 px-4 pb-[88px] pt-[132px]">
        <Outlet />
      </main>

      {/* 底部固定 TabBar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.07] bg-ink-900/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        <div className="flex">
          {TABS.map((tab) => {
            const active = location.pathname === tab.key;
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => {
                  // 下单等写操作在页面内部自行要求登录
                  navigate(tab.key);
                }}
                className={clsx(
                  'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors',
                  active ? 'text-btc-light' : 'text-muted',
                )}
              >
                {active ? (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-btc-gradient" />
                ) : null}
                <Icon size={19} strokeWidth={active ? 2.3 : 1.7} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>

      {modal}
    </div>
  );
}
