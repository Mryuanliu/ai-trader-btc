import { Alert, Button, Card, Col, Collapse, Progress, Row, Space, Spin, Tag, Tooltip } from 'antd';
import { ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { useAiMarketAnalysis, useRefreshAiMarket } from '@/api/hooks';
import { formatPct, formatPrice, formatTime } from '@/utils/format';
import clsx from 'clsx';

const REGIME_LABEL: Record<string, string> = {
  trending: '趋势行情',
  ranging: '震荡行情',
  volatile: '高波动',
};

const POSITION_LABEL: Record<string, string> = {
  positive: '偏多',
  neutral: '中性',
  negative: '偏空',
};

/**
 * AI 行情分析（独立页面）。
 *
 * 这里展示的是**市场解读**，不是交易建议：平台不使用 AI 的输出去下单，
 * 买卖完全由策略自行决定。模型不可用时照样展示本地客观指标。
 */
export function AdminAiMarket() {
  const { data, isLoading } = useAiMarketAnalysis();
  const refresh = useRefreshAiMarket();

  const price = data?.price ?? 0;
  const change = data?.changePercent24h ?? 0;
  const ok = data?.ok ?? false;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[17px] font-semibold text-white">AI 行情</h2>
          <div className="muted-text mt-0.5">
            大模型只做市场解读，<span className="text-subtle">输出不参与交易决策</span>
          </div>
        </div>
        <Space>
          {data?.generatedAt ? (
            <span className="muted-text">更新于 {formatTime(data.generatedAt)}</span>
          ) : null}
          <Button
            icon={<ReloadOutlined spin={refresh.isPending} />}
            loading={refresh.isPending}
            onClick={() => refresh.mutate('BTCUSDT')}
          >
            重新分析
          </Button>
        </Space>
      </div>

      {/* 顶部行情条 */}
      <Card className="!border-white/[0.06] !bg-white/[0.02]">
        <Row gutter={[16, 16]} align="middle">
          <Col xs={12} md={6}>
            <div className="muted-text">BTC / USDT</div>
            <div className="num mt-0.5 text-[20px] font-semibold text-white">
              {price > 0 ? formatPrice(price) : '--'}
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="muted-text">24h 涨跌</div>
            <div className={clsx('num mt-0.5 text-[16px]', change >= 0 ? 'text-up' : 'text-down')}>
              {data ? formatPct(change) : '--'}
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="muted-text">ATR14 (1h)</div>
            <div className="num mt-0.5 text-[16px] text-white">
              {data && data.atr > 0 ? data.atr.toFixed(2) : '--'}
            </div>
          </Col>
          <Col xs={12} md={6}>
            <div className="muted-text">相对 MA30 偏离</div>
            <div
              className={clsx(
                'num mt-0.5 text-[16px]',
                (data?.maDeviationPct ?? 0) >= 0 ? 'text-up' : 'text-down',
              )}
            >
              {data ? `${data.maDeviationPct.toFixed(2)}%` : '--'}
            </div>
          </Col>
        </Row>
      </Card>

      {isLoading ? (
        <Card className="!border-white/[0.06] !bg-white/[0.02]">
          <Spin /> <span className="muted-text ml-3">正在分析…</span>
        </Card>
      ) : null}

      {!isLoading && !ok && data?.error ? (
        <Alert type="warning" showIcon message="AI 分析不可用" description={data.error} />
      ) : null}

      {/* AI 判断 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            className="!border-white/[0.06] !bg-white/[0.02]"
            title={
              <span>
                <RobotOutlined className="mr-2" />
                市场状态
              </span>
            }
          >
            <div className="flex items-center gap-3">
              <Tag color={ok ? 'blue' : 'default'} className="!text-[13px]">
                {data?.regime ? (REGIME_LABEL[data.regime] ?? data.regime) : '未判定'}
              </Tag>
              {data?.model ? <span className="muted-text">{data.model}</span> : null}
            </div>
            <div className="mt-4">
              <div className="muted-text mb-1">判断置信度</div>
              <Progress
                percent={Math.round((data?.regimeConfidence ?? 0) * 100)}
                strokeColor="#f7931a"
                size="small"
              />
            </div>
            <div className="mt-3">
              <div className="muted-text mb-1">建议激进度</div>
              <Progress
                percent={Math.round((data?.aggression ?? 0) * 100)}
                strokeColor="#4b9cff"
                size="small"
              />
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card className="!border-white/[0.06] !bg-white/[0.02]" title="情绪与视角">
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <span className="muted-text">新闻情绪</span>
                  <span className="num text-subtle">
                    {data?.newsSentiment === null || data?.newsSentiment === undefined
                      ? '--'
                      : data.newsSentiment.toFixed(2)}
                  </span>
                </div>
                <Progress
                  percent={Math.round(((data?.newsSentiment ?? 0) + 1) * 50)}
                  showInfo={false}
                  strokeColor={(data?.newsSentiment ?? 0) >= 0 ? '#16c784' : '#ea3943'}
                  size="small"
                  className="mt-1"
                />
                <div className="muted-text mt-1 flex justify-between">
                  <span>-1 极空</span>
                  <span>+1 极多</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="muted-text">持仓视角</span>
                <Tag
                  color={
                    data?.positionView === 'positive'
                      ? 'green'
                      : data?.positionView === 'negative'
                        ? 'red'
                        : 'default'
                  }
                >
                  {data?.positionView ? POSITION_LABEL[data.positionView] : '--'}
                </Tag>
              </div>
              <div className="flex items-center justify-between">
                <span className="muted-text">参考新闻</span>
                <span className="num text-subtle">{data?.newsCount ?? 0} 条</span>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 点评 */}
      <Card className="!border-white/[0.06] !bg-white/[0.02]" title="AI 点评">
        {data?.comment ? (
          <div className="text-[13px] leading-relaxed text-white">{data.comment}</div>
        ) : (
          <div className="muted-text">暂无点评</div>
        )}
      </Card>

      {/* 推理过程 */}
      {data?.reasoning ? (
        <Collapse
          className="!border-white/[0.06] !bg-white/[0.02]"
          items={[
            {
              key: 'reasoning',
              label: '模型推理过程',
              children: (
                <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-subtle">
                  {data.reasoning}
                </pre>
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
