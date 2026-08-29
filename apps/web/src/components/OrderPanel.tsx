import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Drawer, InputNumber, Modal, Segmented, Slider } from 'antd';
import clsx from 'clsx';
import { usePlaceOrder } from '@/api/hooks';
import { useAuthStore } from '@/store/auth';
import { formatPrice, formatUsd } from '@/utils/format';
import {
  RUN_MODE_LABELS,
  type ExchangeCode,
  type OrderSide,
  type OrderType,
  type RunMode,
} from '@ai-trader/shared';

interface Props {
  open: boolean;
  onClose: () => void;
  side: OrderSide;
  price: number;
  quoteFree: number;
  baseFree: number;
  symbol?: string;
  exchange?: ExchangeCode;
  mode?: RunMode;
  maxOrderAmount?: number;
}

/** 下单面板：移动端以底部抽屉呈现，PC 端以弹窗呈现 */
export function OrderPanel({
  open,
  onClose,
  side,
  price,
  quoteFree,
  baseFree,
  symbol = 'BTCUSDT',
  exchange = 'binance',
  mode = 'dry_run',
  maxOrderAmount = 0,
}: Props) {
  const { message } = AntApp.useApp();
  const [type, setType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number>(price);
  const [pct, setPct] = useState(30);
  const place = usePlaceOrder();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (price > 0) setLimitPrice(Number(price.toFixed(2)));
  }, [price]);

  const execPrice = type === 'LIMIT' && limitPrice > 0 ? limitPrice : price;

  const quantity = useMemo(() => {
    if (execPrice <= 0) return 0;
    if (side === 'BUY') return (quoteFree * (pct / 100)) / execPrice;
    return baseFree * (pct / 100);
  }, [execPrice, quoteFree, baseFree, pct, side]);

  const quoteAmount = quantity * execPrice;
  const overLimit = maxOrderAmount > 0 && quoteAmount > maxOrderAmount;
  const insufficient = side === 'BUY' ? quoteAmount > quoteFree : quantity > baseFree;

  const submit = async () => {
    if (!token) {
      message.warning('请先在右上角登录后再下单');
      return;
    }
    if (!(quantity > 0)) {
      message.warning('可下单数量为 0，请检查可用余额');
      return;
    }
    try {
      const order = await place.mutateAsync({
        exchange,
        symbol,
        side,
        type,
        quantity: Number(quantity.toFixed(8)),
        price: type === 'LIMIT' ? limitPrice : undefined,
      });
      message.success(
        `${side === 'BUY' ? '买入' : '卖出'} 已提交：${order.quantity.toFixed(6)} ${symbol}`,
      );
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const body = (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <Segmented
          value={side}
          options={[
            { label: '买入', value: 'BUY' },
            { label: '卖出', value: 'SELL' },
          ]}
          disabled
        />
        <Segmented
          value={type}
          onChange={(v) => setType(v as OrderType)}
          options={[
            { label: '市价', value: 'MARKET' },
            { label: '限价', value: 'LIMIT' },
          ]}
        />
      </div>

      {type === 'LIMIT' ? (
        <label className="block">
          <span className="muted-text mb-1.5 block">限价（USDT）</span>
          <InputNumber
            value={limitPrice}
            onChange={(v) => setLimitPrice(Number(v ?? 0))}
            min={0}
            step={0.01}
            className="!w-full"
            size="large"
            stringMode={false}
          />
          <span className="mt-1 block text-[11px] text-muted">
            当前市价 {formatPrice(price)} USDT
          </span>
        </label>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="muted-text">仓位比例</span>
          <span className="num text-[13px] text-btc-light">{pct}%</span>
        </div>
        <Slider
          value={pct}
          onChange={setPct}
          min={1}
          max={100}
          marks={{ 25: '25%', 50: '50%', 75: '75%', 100: '全部' }}
        />
        <div className="mt-1 flex justify-between text-[11px] text-muted">
          <span>可用 USDT {formatUsd(quoteFree)}</span>
          <span>可用 BTC {baseFree.toFixed(6)}</span>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4">
        <Row label="下单数量" value={`${quantity.toFixed(6)} BTC`} highlight />
        <Row label="成交均价" value={`${formatPrice(execPrice)} USDT`} />
        <Row label="预计金额" value={`${formatUsd(quoteAmount)} USDT`} highlight />
        <Row label="运行模式" value={RUN_MODE_LABELS[mode]} />
      </div>

      {overLimit ? (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          预计金额超过单笔上限 {formatUsd(maxOrderAmount)} USDT，将被风控拦截
        </div>
      ) : null}
      {insufficient ? (
        <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down">
          可用余额不足，请降低仓位比例
        </div>
      ) : null}
    </div>
  );

  const footer = (
    <div className="flex gap-3">
      <Button block size="large" onClick={onClose}>
        取消
      </Button>
      <Button
        block
        size="large"
        type="primary"
        loading={place.isPending}
        onClick={submit}
        danger={side === 'SELL'}
        className={clsx(side === 'BUY' && '!bg-btc-gradient !text-ink-900 !border-none')}
      >
        确认{side === 'BUY' ? '买入' : '卖出'}
      </Button>
    </div>
  );

  return (
    <>
      <div className="hidden md:block">
        <Modal
          open={open}
          title={`${side === 'BUY' ? '买入' : '卖出'} ${symbol}`}
          onCancel={onClose}
          footer={footer}
          width={440}
          destroyOnClose
        >
          <div className="mt-4">{body}</div>
        </Modal>
      </div>
      <div className="md:hidden">
        <Drawer
          open={open}
          title={`${side === 'BUY' ? '买入' : '卖出'} ${symbol}`}
          onClose={onClose}
          placement="bottom"
          height="auto"
          footer={<div className="pt-3">{footer}</div>}
          destroyOnClose
        >
          {body}
        </Drawer>
      </div>
    </>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[12px] text-subtle">{label}</span>
      <span className={clsx('num text-[13px]', highlight ? 'text-white' : 'text-subtle')}>
        {value}
      </span>
    </div>
  );
}
