import { Tag } from 'antd';
import { ORDER_STATUS_LABELS, RUN_MODE_LABELS, type OrderStatus, type RunMode } from '@ai-trader/shared';

const STATUS_COLOR: Record<OrderStatus, string> = {
  NEW: 'blue',
  PARTIALLY_FILLED: 'cyan',
  FILLED: 'green',
  CANCELED: 'default',
  REJECTED: 'red',
  EXPIRED: 'default',
  FAILED: 'red',
};

export function OrderStatusTag({ status }: { status: OrderStatus }) {
  return <Tag color={STATUS_COLOR[status]}>{ORDER_STATUS_LABELS[status]}</Tag>;
}

export function SideTag({ side }: { side: 'BUY' | 'SELL' }) {
  return (
    <Tag color={side === 'BUY' ? 'green' : 'red'} style={{ fontWeight: 600 }}>
      {side === 'BUY' ? '买入' : '卖出'}
    </Tag>
  );
}

export function ModeTag({ mode }: { mode: RunMode }) {
  return (
    <Tag color={mode === 'live' ? 'red' : mode === 'testnet' ? 'gold' : 'blue'}>
      {RUN_MODE_LABELS[mode]}
    </Tag>
  );
}

// ActionTag（BUY/SELL/HOLD 决策标签）已随决策引擎移除——不再有决策动作可展示
