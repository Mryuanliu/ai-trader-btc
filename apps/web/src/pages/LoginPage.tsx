import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Card, Form, Input } from 'antd';
import { useLogin } from '@/api/hooks';
import { useAuthStore } from '@/store/auth';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const login = useLogin();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.token);
  const { message } = AntApp.useApp();
  const [submitting, setSubmitting] = useState(false);

  // 已登录直接回到来路或后台首页
  useEffect(() => {
    if (token) {
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      navigate(from && from !== '/login' ? from : '/admin', { replace: true });
    }
  }, [token, navigate, location.state]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const res = await login.mutateAsync(values);
      setAuth(res.accessToken, res.user.username);
      message.success('登录成功');
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      navigate(from && from !== '/login' ? from : '/admin', { replace: true });
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4">
      <Card className="w-full max-w-[420px] border-white/[0.08] bg-ink-900/80 shadow-2xl backdrop-blur-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-btc-gradient text-[22px] font-bold text-ink-900">
            ₿
          </div>
          <h1 className="text-[20px] font-semibold text-white">AI Trader</h1>
          <p className="mt-1 text-[12px] text-muted">BTC 智能交易终端 · 管理员登录</p>
        </div>

        <Form form={form} layout="vertical" initialValues={{ username: 'admin' }}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="admin" autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="默认 admin12345"
              autoComplete="current-password"
              size="large"
            />
          </Form.Item>
        </Form>

        <p className="muted-text mb-5 -mt-2">
          默认账号在首次启动时根据 <code className="text-btc-light">ADMIN_USERNAME</code> /{' '}
          <code className="text-btc-light">ADMIN_PASSWORD</code> 自动创建。
        </p>

        <Button
          type="primary"
          size="large"
          block
          onClick={submit}
          loading={submitting}
          className="!h-11 !bg-btc-gradient !font-medium !text-ink-900"
        >
          登录
        </Button>
      </Card>
    </div>
  );
}
