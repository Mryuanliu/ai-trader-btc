import { useState } from 'react';
import clsx from 'clsx';
import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons';
import type { DecisionRecord } from '@ai-trader/shared';
import { formatPct, formatPrice, formatQty, formatTime } from '@/utils/format';

interface Node {
  key: string;
  title: string;
  summary: string;
  detail?: unknown;
  tone?: 'default' | 'up' | 'down' | 'warn' | 'btc';
}

const TONE_DOT: Record<string, string> = {
  default: 'bg-white/30',
  up: 'bg-up',
  down: 'bg-down',
  warn: 'bg-warn',
  btc: 'bg-btc',
};

/** 决策链条时间线：行情 → 指标信号 → Prompt → 模型输出 → 风控 → 下单结果 */
export function DecisionTimeline({ record }: { record: DecisionRecord }) {
  const { inputSnapshot: snap, risk } = record;

  const nodes: Node[] = [
    {
      key: 'market',
      title: '行情快照',
      summary: `${record.symbol} · ${snap.timeframe} · 最新价 ${formatPrice(snap.ticker.price)} · 24h ${formatPct(
        snap.ticker.changePercent24h,
      )}`,
      detail: {
        最新价: snap.ticker.price,
        '24h 涨跌': `${formatPct(snap.ticker.changePercent24h)}`,
        '24h 最高': snap.ticker.high24h,
        '24h 最低': snap.ticker.low24h,
        '24h 成交量': snap.ticker.volume24h,
        K线根数: snap.candles.length,
        最近5根: snap.candles.slice(-5).map((c) => ({
          时间: formatTime(c.time),
          开: c.open,
          高: c.high,
          低: c.low,
          收: c.close,
          量: Number(c.volume.toFixed(4)),
        })),
      },
      tone: 'default',
    },
    {
      key: 'indicators',
      title: '指标信号',
      summary: `综合倾向 ${snap.indicatorScore.toFixed(2)}（-1 极空 ~ +1 极多）· 共 ${snap.signals.length} 个信号`,
      detail: {
        综合倾向: snap.indicatorScore,
        指标数值: snap.indicators,
        信号明细: snap.signals.map((s) => ({
          指标: s.label,
          数值: s.value,
          方向: s.bias,
          权重: s.weight,
          说明: s.note,
        })),
      },
      tone: snap.indicatorScore >= 0 ? 'up' : 'down',
    },
    {
      key: 'news',
      title: '新闻上下文',
      summary: snap.news.length > 0 ? `引用 ${snap.news.length} 条近期新闻` : '无新闻输入',
      detail: snap.news,
      tone: 'btc',
    },
    {
      key: 'prompt',
      title: '组装 Prompt',
      summary: `共 ${record.prompt.length} 字符（模型输入）`,
      detail: record.prompt,
      tone: 'default',
    },
    {
      key: 'llm',
      title: '模型调用',
      summary: record.degraded
        ? `AI 上下文回落默认参数：${record.degradeReason ?? '模型不可用'}（策略继续执行，不停摆）`
        : [
            `动作 ${record.action}`,
            `置信度 ${(record.confidence * 100).toFixed(0)}%`,
            record.llmModel ? `模型 ${record.llmModel}` : null,
            record.llmUsage ? `${record.llmUsage.total} tokens` : null,
          ]
            .filter(Boolean)
            .join(' · '),
      detail: {
        实际模型: record.llmModel ?? null,
        是否降级: record.degraded,
        降级原因: record.degradeReason ?? null,
        'Token 用量': record.llmUsage ?? null,
        思维链: record.llmReasoning ?? null,
        正式回答: record.llmRaw ?? null,
      },
      tone: record.degraded ? 'warn' : 'btc',
    },
    // 推理模型的思维链单独成节点，便于完整回溯思考过程
    ...(record.llmReasoning
      ? [
          {
            key: 'reasoning',
            title: '模型思维链',
            summary: `推理模型输出的完整思考过程，共 ${record.llmReasoning.length} 字符`,
            detail: record.llmReasoning,
            tone: 'btc' as const,
          },
        ]
      : []),
    {
      key: 'response',
      title: '模型原始输出',
      summary: record.llmRaw
        ? `content 字段，共 ${record.llmRaw.length} 字符`
        : '未返回正文（结果取自思维链）',
      detail: record.llmRaw ?? null,
      tone: 'default',
    },
    {
      key: 'risk',
      title: '风控裁决',
      summary: risk.passed
        ? `通过${risk.note ? `：${risk.note}` : ''}`
        : `拦截（${risk.rejectedBy ?? 'UNKNOWN'}）：${risk.note ?? ''}`,
      detail: {
        通过: risk.passed,
        拦截码: risk.rejectedBy ?? null,
        说明: risk.note ?? null,
        风险提示: record.riskNotes ?? null,
        账户快照: snap.account,
      },
      tone: risk.passed ? 'up' : 'down',
    },
    {
      key: 'order',
      title: '下单结果',
      summary: record.orderId
        ? `已生成订单 ${record.orderId.slice(0, 8)}…`
        : '未产生订单（观望或被拦截）',
      detail: {
        订单ID: record.orderId ?? null,
        决策理由: record.reason,
        下单数量参考:
          record.action === 'HOLD'
            ? null
            : formatQty(
                record.action === 'BUY'
                  ? (snap.account.quoteFree * 0.1) / (snap.ticker.price || 1)
                  : snap.account.baseFree * 0.1,
              ),
      },
      tone: record.orderId ? 'up' : 'default',
    },
  ];

  return (
    <div className="flex flex-col">
      {nodes.map((node, index) => (
        <TimelineNode
          key={node.key}
          node={node}
          last={index === nodes.length - 1}
          defaultOpen={node.key === 'llm' || node.key === 'risk'}
        />
      ))}
    </div>
  );
}

function TimelineNode({
  node,
  last,
  defaultOpen = false,
}: {
  node: Node;
  last: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', TONE_DOT[node.tone ?? 'default'])} />
        {!last ? <span className="mt-1 w-px flex-1 bg-white/10" /> : null}
      </div>
      <div className={clsx('flex-1', last ? 'pb-1' : 'pb-5')}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start gap-1.5 text-left transition-colors hover:text-btc-light"
        >
          <span className="mt-[1px] text-white/40">
            {open ? <CaretDownOutlined /> : <CaretRightOutlined />}
          </span>
          <span className="flex-1">
            <span className="text-[13px] font-medium text-white/90">{node.title}</span>
            <span className="mt-0.5 block break-all text-[11px] leading-relaxed text-muted">
              {node.summary}
            </span>
          </span>
        </button>
        {open ? (
          <pre className="mt-2 max-h-72 overflow-auto rounded-xl border border-white/[0.07] bg-black/35 p-3 text-[11px] leading-relaxed text-subtle">
            {typeof node.detail === 'string'
              ? node.detail
              : JSON.stringify(node.detail, null, 2) ?? 'null'}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
