import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Button, Tooltip, Badge } from 'antd';
import {
  DashboardOutlined,
  SettingOutlined,
  NodeIndexOutlined,
  ReadOutlined,
  ProfileOutlined,
  BankOutlined,
  SafetyCertificateOutlined,
  ReloadOutlined,
  MobileOutlined,
} from '@ant-design/icons';
import clsx from 'clsx';
import { useOverview } from '@/api/hooks';
import { useRealtimeStore } from '@/ws/realtime';
import { EnvBadge, LivePulse } from '@/components/StatusBits';
import { LogoutButton, useRequireAuth } from '@/components/AuthGate';
import { formatPct, formatPrice } from '@/utils/format';

const { Sider, Header, Content } = Layout;

const MENU = [
  { key: '/admin', icon: <DashboardOutlined />, label: '总览看板' },
  { key: '/admin/agent', icon: <SettingOutlined />, label: 'Agent 配置' },
  { key: '/admin/decisions', icon: <NodeIndexOutlined />, label: '决策历史' },
  { key: '/admin/news', icon: <ReadOutlined />, label: '新闻与市场' },
  { key: '/admin/orders', icon: <ProfileOutlined />, label: '订单成交' },
  { key: '/admin/accounts', icon: <BankOutlined />, label: '交易所账户' },
  { key: '/admin/risk', icon: <SafetyCertificateOutlined />, label: '风控事件' },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data, refetch, isFetching } = useOverview();
  const connected = useRealtimeStore((s) => s.connected);
  const livePrice = useRealtimeStore((s) => s.price);
  const { modal } = useRequireAuth();

  const selectedKey = useMemo(() => {
    const exact = MENU.find((m) => m.key === location.pathname);
    if (exact) return exact.key;
    const matched = MENU.filter((m) => location.pathname.startsWith(`${m.key}/`)).sort(
      (a, b) => b.key.length - a.key.length,
    )[0];
    return matched?.key ?? '/admin';
  }, [location.pathname]);

  const price = livePrice?.price ?? data?.ticker?.price ?? 0;
  const change = livePrice?.changePercent24h ?? data?.ticker?.changePercent24h ?? 0;
  const marketOk = data?.dataSources?.find((s) => s.name === 'market')?.ok ?? false;
  const llmOk = data?.dataSources?.find((s) => s.name === 'llm')?.ok ?? false;

  return (
    <Layout className="min-h-screen !bg-transparent">
      <Sider
        width={208}
        className="fixed inset-y-0 left-0 z-20 hidden border-r border-white/[0.06] bg-ink-900/70 backdrop-blur-xl md:block"
        theme="dark"
      >
        <div className="flex h-16 items-center gap-2.5 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-btc-gradient text-[15px] font-bold text-ink-900">
            ₿
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-white">AI Trader</div>
            <div className="text-[10px] text-muted">BTC 智能交易终端</div>
          </div>
        </div>
        <Menu
          mode="inline"
          theme="dark"
          selectedKeys={[selectedKey]}
          items={MENU.map((m) => ({ key: m.key, icon: m.icon, label: m.label }))}
          onClick={({ key }) => navigate(key)}
          className="!border-none"
        />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <div className="divider-x mb-3" />
          <button
            onClick={() => navigate('/m')}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] py-2 text-[12px] text-subtle transition-colors hover:border-btc/40 hover:text-btc-light"
          >
            <MobileOutlined /> 切换到移动视图
          </button>
        </div>
      </Sider>

      <Layout className="!bg-transparent md:pl-[208px]">
        <Header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-white/[0.06] bg-ink-900/80 px-6 backdrop-blur-xl">
          <div className="flex items-center gap-5">
            <div>
              <div className="muted-text">BTC / USDT</div>
              <div className="flex items-baseline gap-2">
                <span
                  key={price}
                  className="num text-[19px] font-semibold text-white animate-fade-in-up"
                >
                  {formatPrice(price)}
                </span>
                <span className={clsx('num text-[12px]', change >= 0 ? 'text-up' : 'text-down')}>
                  {formatPct(change)}
                </span>
              </div>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              {data ? <EnvBadge mode={data.mode} /> : null}
              <LivePulse ok={marketOk} text={marketOk ? '实时行情' : '模拟行情'} />
              <LivePulse ok={llmOk} text={llmOk ? '大模型在线' : '模型降级'} />
              <LivePulse ok={connected} text={connected ? 'WS 已连接' : 'WS 未连接'} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Tooltip title="刷新聚合数据">
              <Button
                icon={<ReloadOutlined spin={isFetching} />}
                size="small"
                onClick={() => void refetch()}
                className="!border-white/10 !bg-white/[0.04] !text-subtle"
              >
                刷新
              </Button>
            </Tooltip>
            <Badge
              dot
              status={data?.agentEnabled ? 'processing' : 'default'}
              text={
                <span className="text-[12px] text-subtle">
                  Agent {data?.agentEnabled ? '运行中' : '已停止'}
                </span>
              }
            />
            <LogoutButton />
          </div>
        </Header>

        <Content className="p-6">
          <Outlet />
        </Content>
      </Layout>

      {modal}
    </Layout>
  );
}
