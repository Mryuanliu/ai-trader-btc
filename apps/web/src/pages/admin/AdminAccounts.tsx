import { useEffect, useState } from 'react';
import {
  App as AntApp,
  Button,
  Col,
  Form,
  Input,
  Row,
  Segmented,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import { ApiOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABELS,
  MARKET_LABELS,
  marketOfExchange,
  type Environment,
  type ExchangeCode,
} from '@ai-trader/shared';
import { useAccounts, useTestAccount, useUpdateAccount } from '@/api/hooks';
import { useRequireAuth } from '@/components/AuthGate';
import { LivePulse } from '@/components/StatusBits';

interface AccountFormValues {
  label: string;
  environment: Environment;
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/**
 * 合约交易所账户页。
 *
 * 仅合约模式下只有 binance-futures 一个账户，直接展示该账户的密钥配置，
 * 不再需要交易所切换 Tab。Passphrase 为欧意专属字段，已移除。
 */
export function AdminAccounts() {
  const { data, isLoading, refetch } = useAccounts();
  const update = useUpdateAccount();
  const test = useTestAccount();
  const { message } = AntApp.useApp();
  const { run: requireAuth, modal, token } = useRequireAuth();
  const [forms] = Form.useForm<AccountFormValues>();

  const current = data?.find((a) => a.exchange === 'binance-futures');

  useEffect(() => {
    if (current) {
      forms.setFieldsValue({
        label: current.label,
        environment: current.environment,
        enabled: current.enabled,
        apiKey: '',
        apiSecret: '',
        passphrase: '',
      });
    }
  }, [current, forms]);

  const save = async () => {
    const values = await forms.validateFields();
    try {
      await update.mutateAsync({
        exchange: 'binance-futures',
        patch: {
          label: values.label,
          environment: values.environment,
          enabled: values.enabled,
          // 留空表示不修改密钥
          ...(values.apiKey ? { apiKey: values.apiKey } : {}),
          ...(values.apiSecret ? { apiSecret: values.apiSecret } : {}),
        },
      });
      message.success('已保存，密钥以密文存储');
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onTest = () => {
    test.mutate('binance-futures' as ExchangeCode, {
      onSuccess: (res) =>
        res.ok ? message.success(res.message) : message.warning(res.message),
      onError: (err) => message.error(err.message),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
            <SafetyCertificateOutlined className="text-btc-light" />
            合约交易所账户与密钥
          </div>
          <div className="muted-text mt-1">
            币安 U 本位合约账户（binance-futures）。API Key 使用 AES-256-GCM 加密落库，
            接口只返回掩码，保存后无法在前端查看明文。
          </div>
        </div>
        {!token ? (
          <Tag color="orange">登录后才能查看与修改密钥配置</Tag>
        ) : (
          <LivePulse ok={Boolean(data?.some((a) => a.configured && a.reachable))} text="已配置账户" />
        )}
      </div>

      <div className="glass-card p-4">
        {current ? (
          <Row gutter={24}>
            <Col xs={24} lg={10}>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="section-title">{current.label}</span>
                  <Tag color={current.enabled ? 'green' : 'default'}>
                    {current.enabled ? '已启用' : '已停用'}
                  </Tag>
                </div>
                <RowOf
                  label="市场"
                  value={`${MARKET_LABELS[marketOfExchange('binance-futures')]} · U 本位永续`}
                />
                <RowOf label="环境" value={ENVIRONMENT_LABELS[current.environment]} />
                <RowOf label="API Key" value={current.apiKeyMasked || '未配置'} mono />
                <RowOf
                  label="连通性"
                  value={
                    current.reachable ? (
                      <span className="text-up">正常</span>
                    ) : (
                      <span className="text-muted">{current.message || '未测试'}</span>
                    )
                  }
                />
                <div className="divider-x my-3" />
                <div className="muted-text">{current.message || '点击右侧「测试连接」验证密钥可用性'}</div>
              </div>
            </Col>

            <Col xs={24} lg={14}>
              <Form form={forms} layout="vertical">
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item name="label" label="账户备注">
                      <Input placeholder="主合约账户" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      name="environment"
                      label={
                        <Tooltip title="决定合约交易请求发往哪个主机；模拟盘为币安官方 Demo 合约（demo-fapi.binance.com），余额可在币安网页端随时重置">
                          <span className="border-b border-dashed border-white/25">环境</span>
                        </Tooltip>
                      }
                    >
                      <Segmented
                        options={ENVIRONMENTS.map((env) => ({
                          label: ENVIRONMENT_LABELS[env],
                          value: env,
                        }))}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="enabled" label="启用该合约账户下单" valuePropName="checked">
                  <Switch checkedChildren="启用" unCheckedChildren="停用" />
                </Form.Item>
                <Form.Item name="apiKey" label="API Key（留空表示不修改）">
                  <Input.Password placeholder={current.apiKeyMasked || '请输入新的 API Key'} autoComplete="off" />
                </Form.Item>
                <Form.Item name="apiSecret" label="API Secret（留空表示不修改）">
                  <Input.Password placeholder="请输入新的 API Secret" autoComplete="off" />
                </Form.Item>
                <div className="flex gap-3">
                  <Button
                    type="primary"
                    loading={update.isPending}
                    onClick={() => requireAuth(save)}
                    className="!bg-btc-gradient !border-none !text-ink-900"
                  >
                    保存配置
                  </Button>
                  <Button
                    icon={<ApiOutlined />}
                    loading={test.isPending}
                    onClick={() => requireAuth(onTest)}
                    className="!border-white/10 !bg-white/[0.04] !text-subtle"
                  >
                    测试连接
                  </Button>
                  <Button type="text" onClick={() => void refetch()} loading={isLoading}>
                    刷新
                  </Button>
                </div>
              </Form>
            </Col>
          </Row>
        ) : (
          <div className="py-10 text-center text-[12px] text-muted">加载中…</div>
        )}
      </div>

      <div className="glass-card p-4">
        <span className="section-title">接入说明</span>
        <ul className="mt-3 flex flex-col gap-2 text-[12px] leading-relaxed text-subtle">
          <li>
            · <span className="text-white">币安合约模拟盘（推荐）</span>：登录后到
            <span className="text-btc-light">https://demo.binance.com/en/my/settings/api-management</span>{' '}
            创建密钥，并确认已勾选「启用未来(合约)」权限。合约请求发往{' '}
            <code className="text-btc-light">demo-fapi.binance.com</code>，与现货共用同一套 API Key，
            余额可在网页端随时重置。
          </li>
          <li>· 只想先跑通链路：保持运行模式为「模拟撮合」即可，无需任何密钥，下单按当前市价模拟撮合并写入数据库。</li>
          <li>· 切换「实盘」前请务必先在模拟盘验证策略，并设置合理的杠杆、强平距离预警与逐仓模式。</li>
          <li>
            · 访问境外接口受阻时，在 <code className="text-btc-light">.env</code> 配置{' '}
            <code className="text-btc-light">HTTPS_PROXY</code>（REST 与 WebSocket 同时生效）。
          </li>
        </ul>
      </div>
      {modal}
    </div>
  );
}

function RowOf({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className={mono ? 'num text-white/90' : 'text-white/90'}>{value}</span>
    </div>
  );
}
