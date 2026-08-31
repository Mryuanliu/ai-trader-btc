import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { LoginPage } from '@/pages/LoginPage';
import { AdminLayout } from '@/layouts/AdminLayout';
import { MobileLayout } from '@/layouts/MobileLayout';
import { AdminOverview } from '@/pages/admin/AdminOverview';
import { AdminAgentConfig } from '@/pages/admin/AdminAgentConfig';
import { AdminDecisions } from '@/pages/admin/AdminDecisions';
import { AdminNews } from '@/pages/admin/AdminNews';
import { AdminOrders } from '@/pages/admin/AdminOrders';
import { AdminAccounts } from '@/pages/admin/AdminAccounts';
import { AdminRisk } from '@/pages/admin/AdminRisk';
import { AdminBacktest } from '@/pages/admin/AdminBacktest';
import { AdminFutures } from '@/pages/admin/AdminFutures';
import { MobileHome } from '@/pages/mobile/MobileHome';
import { MobileTrade } from '@/pages/mobile/MobileTrade';
import { MobileOrders } from '@/pages/mobile/MobileOrders';
import { MobileAgent } from '@/pages/mobile/MobileAgent';
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
        <Route path="orders" element={<MobileOrders />} />
        <Route path="agent" element={<MobileAgent />} />
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
        <Route path="agent" element={<AdminAgentConfig />} />
        <Route path="decisions" element={<AdminDecisions />} />
        <Route path="news" element={<AdminNews />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="accounts" element={<AdminAccounts />} />
        <Route path="risk" element={<AdminRisk />} />
        <Route path="backtest" element={<AdminBacktest />} />
        <Route path="futures" element={<AdminFutures />} />
      </Route>
      <Route path="*" element={<Navigate to={isMobile ? '/m' : '/admin'} replace />} />
    </Routes>
  );
}
