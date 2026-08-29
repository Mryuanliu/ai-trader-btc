import { App as AntApp, Button, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { useLogin } from '@/api/hooks';
import { useAuthStore } from '@/store/auth';

/** 写操作前的登录弹窗：只有登录后才带 Authorization 头。
 *  required=true 时为「强制登录」模式（未登录访问后台）：不可关闭，登录成功才能继续。 */
export function LoginModal({
  open,
  onClose,
  onSuccess,
  required = false,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  required?: boolean;
}) {
  const [form] = Form.useForm();
  const login = useLogin();
  const setAuth = useAuthStore((s) => s.setAuth);
  const { message } = AntApp.useApp();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const res = await login.mutateAsync(values);
      setAuth(res.accessToken, res.user.username);
      message.success('登录成功');
      onSuccess?.();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="管理员登录"
      onCancel={onClose}
      onOk={submit}
      okText="登录"
      cancelText={required ? undefined : '取消'}
      closable={!required}
      maskClosable={!required}
      keyboard={!required}
      confirmLoading={submitting}
      width={360}
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4" initialValues={{ username: 'admin' }}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input placeholder="admin" autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="默认 admin12345" autoComplete="current-password" />
        </Form.Item>
      </Form>
      <p className="muted-text -mt-2">
        默认账号在首次启动时根据 <code className="text-btc-light">ADMIN_USERNAME</code> /{' '}
        <code className="text-btc-light">ADMIN_PASSWORD</code> 自动创建。
      </p>
    </Modal>
  );
}

/** 需要登录才能执行的操作包装器 */
export function useRequireAuth() {
  const token = useAuthStore((s) => s.token);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);

  const run = (action: () => void) => {
    if (token) {
      action();
      return;
    }
    setPending(() => action);
    setLoginOpen(true);
  };

  const modal = (
    <LoginModal
      open={loginOpen}
      onClose={() => setLoginOpen(false)}
      onSuccess={() => {
        const action = pending;
        setPending(null);
        action?.();
      }}
    />
  );

  return { run, modal, token };
}

export function LogoutButton() {
  const clear = useAuthStore((s) => s.clear);
  const username = useAuthStore((s) => s.username);
  if (!username) return null;
  return (
    <Button size="small" type="text" onClick={clear} className="text-muted hover:text-down">
      退出 {username}
    </Button>
  );
}
