import clsx from 'clsx';
import {
  ENVIRONMENT_LABELS,
  RUN_MODE_LABELS,
  type Environment,
  type RunMode,
} from '@ai-trader/shared';

/** 运行模式徽标：模拟撮合 / 测试网 / 实盘 */
export function EnvBadge({ mode, className }: { mode: RunMode; className?: string }) {
  const tone =
    mode === 'live'
      ? 'bg-down/15 text-down border-down/30'
      : mode === 'testnet'
        ? 'bg-warn/15 text-warn border-warn/30'
        : 'bg-info/15 text-info border-info/30';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] font-medium',
        tone,
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {RUN_MODE_LABELS[mode]}
    </span>
  );
}

const ACCOUNT_ENV_TONE: Record<Environment, string> = {
  demo: 'bg-info/15 text-info border-info/30',
  testnet: 'bg-warn/15 text-warn border-warn/30',
  live: 'bg-down/15 text-down border-down/30',
};

/** 账户环境徽标：模拟盘 / 测试网 / 实盘 */
export function AccountEnvBadge({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] font-medium',
        ACCOUNT_ENV_TONE[environment],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {ENVIRONMENT_LABELS[environment]}
    </span>
  );
}

export function ConnectionDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-subtle">
      <span
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          ok ? 'bg-up animate-pulse-dot' : 'bg-muted',
        )}
      />
      {label}
    </span>
  );
}

export function LivePulse({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={clsx(
        'chip',
        ok ? 'border-up/25 text-up' : 'border-warn/25 text-warn',
      )}
    >
      <span
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          ok ? 'bg-up animate-pulse-dot' : 'bg-warn animate-pulse-dot',
        )}
      />
      {text}
    </span>
  );
}
