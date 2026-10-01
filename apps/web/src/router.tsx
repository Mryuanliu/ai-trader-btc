import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { LoginPage } from '@/pages/LoginPage';
import { AdminLayout } from '@/layouts/AdminLayout';
import { MobileLayout } from '@/layouts/MobileLayout';
import { AdminOverview } from '@/pages/admin/AdminOverview';
import { AdminStrategy } from '@/pages/admin/AdminStrategy';
import { AdminStrategyGovernance } from '@/pages/admin/AdminStrategyGovernance';
import { AdminStrategyDetail } from '@/pages/admin/AdminStrategyDetail';
import { AdminBacktest } from '@/pages/admin/AdminBacktest';
import { AdminAiMarket } from '@/pages/admin/AdminAiMarket';
import { AdminNews } from '@/pages/admin/AdminNews';
import { AdminAccounts } from '@/pages/admin/AdminAccounts';
import { AdminFutures } from '@/pages/admin/AdminFutures';
import { MobileHome } from '@/pages/mobile/MobileHome';
import { MobileTrade } from '@/pages/mobile/MobileTrade';
import { MobileStrategy } from '@/pages/mobile/MobileStrategy';
import { useIsMobile } from '@/hooks/useBreakpoint';

/** 受保护路由：未登录跳登录页，登录后回到原本要访问的地址 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const hasToken = useAuthStore((s) => Boolean(s.token));
  const location = useLocation();

  if (!hasToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}

/** 同一套应用按屏幕宽度切换移动钱包视图与 PC 后台视图 */
export function AppRoutes() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const inMobile = location.pathname.startsWith('/m');
    const inAdmin = location.pathname.startsWith('/admin');
    if (isMobile && inAdmin) {
      navigate('/m', { replace: true });
    } else if (!isMobile && inMobile) {
      navigate('/admin', { replace: true });
    }
  }, [isMobile, location.pathname, navigate]);

  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate to={isMobile ? '/m' : '/admin'} replace />}
      />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/m"
        element={
          <ProtectedRoute>
            <MobileLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<MobileHome />} />
        <Route path="trade" element={<MobileTrade />} />
        <Route path="strategy" element={<MobileStrategy />} />
      </Route>
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminOverview />} />
        <Route path="strategy" element={<AdminStrategy />} />
        {/* 静态段 strategy/governance 优先于动态 strategy/:name 匹配（React Router v6 排序） */}
        <Route path="strategy/governance" element={<AdminStrategyGovernance />} />
        {/* 二级页：运行状态 / 阶梯 / 绩效（列表页只展示策略，详情按递进关系收纳） */}
        <Route path="strategy/:name" element={<AdminStrategyDetail />} />
        <Route path="backtest" element={<AdminBacktest />} />
        <Route path="ai-market" element={<AdminAiMarket />} />
        <Route path="futures" element={<AdminFutures />} />
        <Route path="news" element={<AdminNews />} />
        <Route path="accounts" element={<AdminAccounts />} />
      </Route>
      <Route path="*" element={<Navigate to={isMobile ? '/m' : '/admin'} replace />} />
    </Routes>
  );
}
