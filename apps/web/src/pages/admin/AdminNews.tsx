import { useState } from 'react';
import { Button, Empty, Segmented, Skeleton, Tag, App as AntApp } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import clsx from 'clsx';
import { useKeywordTrends, useMarketPulse, useNews, useNewsSources, useRefreshNews } from '@/api/hooks';
import { KeywordBars, Sparkline } from '@/components/Sparkline';
import { StatCard } from '@/components/StatCard';
import { formatPct, formatPrice, formatRelative, formatTime } from '@/utils/format';
import { useRequireAuth } from '@/components/AuthGate';
import { useCandles } from '@/api/hooks';

export function AdminNews() {
  const [source, setSource] = useState<string>('ALL');
  const [keyword, setKeyword] = useState<string>('');
  const { data, isLoading } = useNews({
    pageSize: 30,
    source: source === 'ALL' ? undefined : source,
    keyword: keyword || undefined,
  });
  const { data: sources = [] } = useNewsSources();
  const { data: trends = [] } = useKeywordTrends(12);
  const { data: pulse } = useMarketPulse('BTCUSDT');
  const { data: candles = [] } = useCandles('BTCUSDT', '1h', 168);
  const refresh = useRefreshNews();
  const { message } = AntApp.useApp();
  const { run: requireAuth, modal } = useRequireAuth();

  const sourceOptions = [
    { label: `全部 (${sources.reduce((a, b) => a + b.count, 0)})`, value: 'ALL' },
    ...sources.map((s) => ({ label: `${s.source} (${s.count})`, value: s.source })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* 市场动向面板 */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="24h 涨跌"
          value={formatPct(pulse?.changePercent24h ?? 0)}
          tone={(pulse?.changePercent24h ?? 0) >= 0 ? 'up' : 'down'}
          hint={`最高 ${formatPrice(pulse?.high24h ?? 0)} / 最低 ${formatPrice(pulse?.low24h ?? 0)}`}
        />
        <StatCard
          label="24h 波动率"
          value={`${(pulse?.volatility24h ?? 0).toFixed(2)}%`}
          hint="基于近 24 根 1 小时 K 线计算"
        />
        <StatCard
          label="量能对比"
          value={`${(pulse?.volumeRatio ?? 0).toFixed(2)}x`}
          tone={(pulse?.volumeRatio ?? 0) >= 1 ? 'btc' : 'default'}
          hint="今日成交量 / 前一日成交量"
        />
        <StatCard
          label="情绪分值"
          value={(pulse?.sentimentScore ?? 0).toFixed(0)}
          tone={(pulse?.sentimentScore ?? 0) >= 0 ? 'up' : 'down'}
          hint={pulse?.summary?.slice(0, 28) ?? ''}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        {/* 新闻流 */}
        <div className="glass-card p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="section-title">外部新闻源</span>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refresh.isPending}
              onClick={() =>
                requireAuth(() => {
                  refresh.mutate(undefined, {
                    onSuccess: (res) =>
                      message.success(
                        res.simulated
                          ? `外部源不可达，已补充 ${res.added} 条模拟新闻`
                          : `抓取完成，新增 ${res.added} 条`,
                      ),
                    onError: (err) => message.error(err.message),
                  });
                })
              }
              className="!border-white/10 !bg-white/[0.04] !text-subtle"
            >
              立即抓取
            </Button>
          </div>

          <Segmented
            block
            size="small"
            value={source}
            onChange={(v) => setSource(String(v))}
            options={sourceOptions}
            className="!mb-3"
          />

          {keyword ? (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[11px] text-muted">关键词筛选：</span>
              <Tag closable color="orange" onClose={() => setKeyword('')}>
                {keyword}
              </Tag>
            </div>
          ) : null}

          {isLoading && !data ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : (
            <div className="flex max-h-[620px] flex-col gap-2.5 overflow-y-auto pr-1">
              {(data?.items ?? []).map((item) => (
                <a
                  key={item.id}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group rounded-xl border border-white/[0.06] bg-black/20 p-3 transition-all hover:border-btc/35 hover:bg-black/30"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-btc-light">{item.source}</span>
                    <span className="text-muted">{formatRelative(item.publishedAt)}</span>
                  </div>
                  <div className="mt-1.5 text-[13px] leading-relaxed text-white/90 group-hover:text-white">
                    {item.title}
                  </div>
                  {item.summary ? (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
                      {item.summary}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {item.tags.map((tag) => (
                      <button
                        key={tag}
                        onClick={(e) => {
                          e.preventDefault();
                          setKeyword(tag);
                        }}
                        className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-subtle transition-colors hover:bg-btc/20 hover:text-btc-light"
                      >
                        {tag}
                      </button>
                    ))}
                    {item.citedCount > 0 ? (
                      <Tag color="orange" className="!ml-auto">
                        已引用 {item.citedCount}
                      </Tag>
                    ) : null}
                  </div>
                </a>
              ))}
              {(data?.items ?? []).length === 0 ? (
                <Empty description="暂无新闻" image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-12" />
              ) : null}
            </div>
          )}
        </div>

        {/* 关键词热度 + 走势 */}
        <div className="flex flex-col gap-4">
          <div className="glass-card p-4">
            <span className="section-title">关键词热度</span>
            <p className="muted-text mt-1">点击关键词可反向筛选新闻</p>
            <div className="mt-3">
              <KeywordBars items={trends} onSelect={(k) => setKeyword(k)} />
            </div>
          </div>

          <div className="glass-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="section-title">近 7 日走势（1h）</span>
              <span className={clsx('num text-[12px]', (pulse?.changePercent24h ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                {formatPct(pulse?.changePercent24h ?? 0)}
              </span>
            </div>
            <Sparkline candles={candles} height={120} up={(pulse?.changePercent24h ?? 0) >= 0} />
            <div className="divider-x my-3" />
            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div>
                <div className="text-muted">统计周期</div>
                <div className="num mt-0.5 text-white">{pulse?.candleCount ?? 0} 根 1h K 线</div>
              </div>
              <div>
                <div className="text-muted">更新时间</div>
                <div className="num mt-0.5 text-white">
                  {pulse ? formatTime(pulse.updatedAt) : '--'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      {modal}
    </div>
  );
}
