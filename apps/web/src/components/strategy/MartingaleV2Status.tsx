import { Alert, Card, Progress, Row, Col, Tag, Tooltip } from 'antd';
import clsx from 'clsx';
import type { StrategyRunStatus } from '@ai-trader/shared';
import { formatPrice, formatQty, formatSignedUsd, formatTime } from '@/utils/format';

/**
 * 马丁网格 V2 · 运行状态区（方案 M8-②）。
 *
 * 只在 `state.stateV === 2` 时由详情页渲染；老策略与其它策略走现有分支零影响。
 * 回答三个问题：**Brain 现在怎么看市场、两侧网格各在等什么、出场链正逼近哪条线**。
 * 数据全部来自策略 getState() 的 stateV:2 快照（M8-① 契约），本组件纯展示零计算决策。
 */

// ---------------------------------------------------------------- stateV:2 契约类型（防御式解析）

interface SideView {
  layers: number;
  lots: number;
  stepNow: number | null;
  multNow: number | null;
  nextAddAt: number | null;
  target: number | null;
  sideNet: number | null;
  progressPct: number | null;
  hit: boolean;
  pending: Array<{ price: number; qty: number; followTarget?: number }>;
  ladder: Array<{ layer: number; price: number; qty: number; filled: boolean }>;
}

interface V2State {
  stateV: 2;
  note?: string;
  basketPeakPct?: number;
  regime?: {
    score: number;
    scoreRaw: number;
    scoreTarget: number;
    dir: number;
    state: number;
    stateText: string;
    chop: number;
    coherence: number;
    conflict: number;
    strength: number;
    frames: Array<{
      mult: number;
      score: number;
      trendiness: number;
      factors?: Record<string, number>;
    }>;
    calibrated?: { slopeNorm: number; macdNorm: number; diNorm: number } | null;
  } | null;
  grid?: {
    perSide: { long: SideView; short: SideView };
    exposure: {
      netLots: number;
      grossNotional: number;
      marginOccupy: number;
      guardRemainLayers: number;
      pivotAlarm: boolean;
    };
  };
  exits?: {
    basket: {
      netUsdt: number;
      netPct: number;
      peakPct: number;
      startNow: number;
      trailArmed: boolean;
      retraceExitAt: number | null;
    };
    side: { long: { targetUsdt: number | null; hit: boolean }; short: { targetUsdt: number | null; hit: boolean } };
    pair: { candidate: { profitLotId: string; riskLotId: string; allowed: boolean; why: string } | null };
    firstTrail: { active: boolean; windowRemainBars: number | null };
  };
  gates?: { spike: boolean; funding: boolean; margin: boolean; atrRatio: number | null };
}

const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOf = (v: unknown): boolean => v === true;
const pct = (v: number | null, d = 2): string => (v == null ? '--' : `${(v * 100).toFixed(d)}%`);

// ---------------------------------------------------------------- 状态带

/** 七态标签色（震荡灰/弱黄/确认蓝/强紫，方案 M8-② 的 StatusBits 范式） */
function stateTone(state: number): { color: string; text: string } {
  const abs = Math.abs(state);
  if (abs === 0) return { color: '#8b949e', text: '震荡' };
  if (abs === 1) return { color: '#d7ba7d', text: state > 0 ? '弱多' : '弱空' };
  if (abs === 2) return { color: '#1f6feb', text: state > 0 ? '多头确认' : '空头确认' };
  return { color: '#8957e5', text: state > 0 ? '强多' : '强空' };
}

function ScoreMeter({ score }: { score: number }) {
  const left = Math.max(0, Math.min(100, ((score + 100) / 200) * 100));
  return (
    <div className="relative mt-1 h-[10px] w-full rounded bg-white/[0.06]">
      {/* 零线居中：−100 左端 / +100 右端 */}
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/25" />
      <div
        className={clsx('absolute top-1/2 h-[10px] -translate-y-1/2 rounded-full', score >= 0 ? 'bg-up' : 'bg-down')}
        style={{
          left: score >= 0 ? '50%' : `${left}%`,
          width: `${Math.abs(score) / 2}%`,
        }}
      />
      <div
        className="absolute top-1/2 h-[14px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-white"
        style={{ left: `${left}%` }}
      />
    </div>
  );
}

function GateBadges({ gates }: { gates: V2State['gates'] }) {
  if (!gates) return null;
  const badges: Array<{ key: string; label: string; tip: string }> = [];
  if (gates.spike)
    badges.push({
      key: 'spike',
      label: '熔断停开',
      tip: `ATR 尖峰 ${gates.atrRatio ?? '--'}× ≥ 门槛：暂停新开/加层（出场链不受影响）`,
    });
  if (gates.funding) badges.push({ key: 'funding', label: 'funding 窗口', tip: '结算前后 ±15min 暂停开层（抗结算波动）' });
  if (gates.margin) badges.push({ key: 'margin', label: '保证金护栏', tip: '本 tick 有挂单被保证金预检拦截（CanAffordOrder 口径）' });
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((b) => (
        <Tooltip key={b.key} title={b.tip}>
          <span className="chip border-down/40 bg-down/15 text-down">
            <span className="h-1.5 w-1.5 rounded-full bg-down" />
            {b.label}
          </span>
        </Tooltip>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 三列

/** ①市场理解：三框架迷你柱 + hover 六因子明细 */
function RegimeColumn({ regime }: { regime: V2State['regime'] }) {
  if (!regime) {
    return (
      <div className="text-[11px] leading-relaxed text-muted">
        Brain 内核未启用（useBrain/useScoreSizing/useExitChain/usePivotCarry 全关）
        ——关断态行为 = 老马丁，市场理解列无数据。
      </div>
    );
  }
  const FACTOR_LABELS: Record<string, string> = {
    slope: 'F1 斜率×拟合 (w0.34)',
    er: 'F2 带符号ER (w0.20)',
    ema: 'F3 EMA结构 (w0.18)',
    macd: 'F4 MACD柱 (w0.12)',
    donchian: 'F5 Donchian突破 (w0.10)',
    di: 'F6 ADX方向 (w0.06)',
  };
  return (
    <div className="space-y-2">
      {regime.frames.map((f) => (
        <Tooltip
          key={f.mult}
          title={
            f.factors ? (
              <div className="text-[11px] leading-relaxed">
                {Object.entries(FACTOR_LABELS).map(([k, label]) => (
                  <div key={k}>
                    {label}：{(f.factors as Record<string, number>)[k] >= 0 ? '+' : ''}
                    {((f.factors as Record<string, number>)[k] ?? 0).toFixed(3)}
                  </div>
                ))}
                <div className="mt-1 opacity-70">score = 方向 × 趋势度 ×100</div>
              </div>
            ) : (
              '六因子明细不可用'
            )
          }
        >
          <div className="cursor-default">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">{f.mult}× 框架</span>
              <span className={`num ${f.score >= 0 ? 'text-up' : 'text-down'}`}>
                {f.score > 0 ? '+' : ''}
                {f.score.toFixed(1)} · 趋势度 {(f.trendiness * 100).toFixed(0)}%
              </span>
            </div>
            {/* 横向柱：零线居中，正绿负红 */}
            <div className="relative mt-0.5 h-[6px] rounded bg-white/[0.06]">
              <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
              <div
                className={clsx('absolute top-0 h-full rounded', f.score >= 0 ? 'bg-up/70' : 'bg-down/70')}
                style={{
                  left: f.score >= 0 ? '50%' : `${50 + Math.min(50, f.score / 2)}%`,
                  width: `${Math.min(50, Math.abs(f.score) / 2)}%`,
                }}
              />
            </div>
          </div>
        </Tooltip>
      ))}
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        <span>
          原始分 <span className="num text-subtle">{regime.scoreRaw.toFixed(1)}</span> → 目标{' '}
          <span className="num text-subtle">{regime.scoreTarget.toFixed(1)}</span>
        </span>
        <span>
          冲突阻尼 <span className="num text-subtle">{pct(regime.conflict, 0)}</span>
          {regime.conflict >= 0.4 ? '（×0.72 生效）' : ''}
        </span>
        <span>
          归一常数 <span className="num text-subtle">{regime.calibrated ? `${regime.calibrated.slopeNorm}/${regime.calibrated.macdNorm}/${regime.calibrated.diNorm}` : '--'}</span>
        </span>
      </div>
    </div>
  );
}

/** ②网格：双侧实际间距/倍率/阶梯/挂单 + carry 高亮 + 敞口护栏 */
function SideBlock({ sideKey, view, carry }: { sideKey: 'long' | 'short'; view: SideView; carry: boolean }) {
  const isLong = sideKey === 'long';
  return (
    <div
      className={clsx(
        'rounded-lg border px-2.5 py-2',
        carry ? 'border-warn/40 bg-warn/[0.06]' : 'border-white/[0.06] bg-black/20',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
        <span className={isLong ? 'text-up' : 'text-down'}>{isLong ? '多头' : '空头'}</span>
        {carry ? <span className="text-warn">carry 模式</span> : null}
        <span className="text-muted">
          <span className="num text-white">{view.layers}</span> 层 ·{' '}
          <span className="num text-white">{formatQty(view.lots, 4)}</span> 手
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
        <span>
          间距 <span className="num text-subtle">{view.stepNow != null ? view.stepNow.toFixed(1) : '--'}</span>
        </span>
        <span>
          倍率 <span className="num text-subtle">{view.multNow != null ? `×${view.multNow.toFixed(3)}` : '--'}</span>
        </span>
        {view.nextAddAt != null ? (
          <span>
            加层需{isLong ? '跌破' : '涨破'}{' '}
            <span className="num text-subtle">{formatPrice(view.nextAddAt)}</span>
          </span>
        ) : null}
      </div>
      {view.target != null ? (
        <div className="mt-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted">
              侧目标 <span className="num text-subtle">{view.target.toFixed(2)}U</span>
              <span className={clsx('ml-1', view.hit ? 'text-up' : 'text-subtle')}>
                （{view.hit ? '达标待执行' : '未达'}）
              </span>
            </span>
          </div>
          <Progress
            percent={Math.max(0, Math.min(100, (view.progressPct ?? 0) * 100))}
            showInfo={false}
            strokeColor={view.hit ? '#0ECB81' : '#1f6feb'}
            trailColor="rgba(255,255,255,0.08)"
            size="small"
          />
        </div>
      ) : null}
      {view.pending.map((p, i) => (
        <div key={i} className="mt-1 flex items-center justify-between text-[10px] text-muted">
          <span>挂单 #{i + 1}</span>
          <span className="num text-white">{formatPrice(p.price)}</span>
          <span className="num">
            {formatQty(p.qty, 4)}
            {p.followTarget != null ? (
              <span className="ml-1 text-warn" title="挂单跟踪中：下一 tick 将撤旧换新追至该价">
                ↝ 将跟至 {formatPrice(p.followTarget)}
              </span>
            ) : null}
          </span>
        </div>
      ))}
      {view.ladder.length > 0 ? (
        <div className="mt-1.5 space-y-[2px] border-t border-white/[0.06] pt-1.5">
          {view.ladder.map((r) => (
            <div key={r.layer} className="flex items-center justify-between text-[10px]">
              <span className={r.filled ? 'text-up' : 'text-muted'}>
                L{r.layer} {r.filled ? '已成交' : '待触发'}
              </span>
              <span className={`num ${r.filled ? 'text-up' : 'text-white'}`}>{formatPrice(r.price)}</span>
              <span className="num text-muted">{formatQty(r.qty, 4)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GridColumn({ grid }: { grid: V2State['grid'] }) {
  if (!grid) return <div className="text-[11px] text-muted">尚无网格快照（等待首个 tick）</div>;
  const carry = grid.exposure.pivotAlarm;
  return (
    <div className="space-y-2">
      <SideBlock sideKey="long" view={grid.perSide.long} carry={carry} />
      <SideBlock sideKey="short" view={grid.perSide.short} carry={carry} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-white/[0.06] pt-2 text-[10px] text-muted">
        <span>
          净手数 <span className="num text-subtle">{grid.exposure.netLots >= 0 ? '+' : ''}{formatQty(grid.exposure.netLots, 4)}</span>
        </span>
        <span>
          名义 <span className="num text-subtle">{grid.exposure.grossNotional.toFixed(0)}U</span>
        </span>
        <span>
          保证金占用 <span className="num text-subtle">{grid.exposure.marginOccupy.toFixed(1)}U</span>
        </span>
        <span>
          剩余可挂层 <span className="num text-subtle">{grid.exposure.guardRemainLayers}</span>
        </span>
      </div>
    </div>
  );
}

/** ③出场：篮子三线横条 + 侧目标×2 + 配对候选 + 首单追踪倒计时 */
function ExitsColumn({ exits }: { exits: V2State['exits'] }) {
  if (!exits) return <div className="text-[11px] text-muted">尚无出场链快照（等待首个 tick）</div>;
  const b = exits.basket;
  // 三线横条标尺：netPct/峰值/启动线/回撤离场线 全落 [lo,hi] 动态归一——
  // 零线与填充起点必须走 pos()，不能硬编码 50%（净益为负时 0 位不在正中）
  const retracePct = b.trailArmed ? Math.min(b.netPct, b.peakPct) : null;
  const scale = [b.netPct, b.peakPct, b.startNow, retracePct ?? b.startNow];
  const lo = Math.min(...scale, 0);
  const hi = Math.max(...scale, b.startNow * 1.5, 0.001);
  const pos = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const clamp = (v: number) => `${Math.max(0, Math.min(100, pos(v)))}%`;
  const zeroPct = pos(0);
  return (
    <div className="space-y-2.5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
          <span className="text-muted">
            篮子净益{' '}
            <span className={`num ${b.netUsdt >= 0 ? 'text-up' : 'text-down'}`}>{formatSignedUsd(b.netUsdt)}U</span>
            <span className="num text-subtle"> / {pct(b.netPct)}</span>
          </span>
          {b.trailArmed ? <span className="chip border-up/30 text-up">追踪已 arm</span> : null}
        </div>
        <div className="relative mt-1 h-[8px] rounded bg-white/[0.06]">
          <div className="absolute top-0 h-full w-px bg-white/15" style={{ left: clamp(0) }} />
          {/* 动态启动线（蓝） */}
          <div className="absolute top-0 h-full w-[2px] bg-info" style={{ left: clamp(b.startNow) }} title={`启动线 ${pct(b.startNow)}`} />
          {/* 价格回撤离场线（紫）：arm 后才有 */}
          {retracePct != null ? (
            <div
              className="absolute top-0 h-full w-[2px] bg-[#8957e5]"
              style={{ left: clamp(retracePct) }}
              title={`回撤离场（判定价峰值 ×(1∓giveback) = ${b.retraceExitAt != null ? formatPrice(b.retraceExitAt) : '--'}）`}
            />
          ) : null}
          {/* 峰值游标（金）与当前值（正=绿填充自零线右延，负=红填充自当前值延到零线） */}
          {b.netPct >= 0 ? (
            <div className="absolute top-0 h-full bg-up/40" style={{ left: clamp(0), width: `${Math.max(0, Math.min(100, pos(b.netPct)) - zeroPct)}%` }} />
          ) : (
            <div className="absolute top-0 h-full bg-down/40" style={{ left: clamp(b.netPct), width: `${Math.max(0, zeroPct - pos(b.netPct))}%` }} />
          )}
          <div className="absolute top-[-3px] h-[14px] w-[2px] bg-warn" style={{ left: clamp(b.peakPct) }} title={`峰值 ${pct(b.peakPct)}`} />
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted">
          <span>启动线 <span className="num text-info">{pct(b.startNow)}</span></span>
          <span>峰值 <span className="num text-warn">{pct(b.peakPct)}</span></span>
          {b.retraceExitAt != null ? (
            <span>撤离价 <span className="num text-[#8957e5]">{formatPrice(b.retraceExitAt)}</span></span>
          ) : null}
        </div>
      </div>
      {(['long', 'short'] as const).map((k) => {
        const s = exits.side[k];
        if (s.targetUsdt == null) return null;
        const pctv = s.targetUsdt > 0 ? (s.hit ? 100 : 0) : 0;
        return (
          <div key={k} className="text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">{k === 'long' ? '多头' : '空头'}均值目标</span>
              <span className={s.hit ? 'text-up' : 'text-subtle'}>{s.targetUsdt.toFixed(2)}U {s.hit ? '已达标' : ''}</span>
            </div>
            <Progress percent={pctv} showInfo={false} strokeColor={s.hit ? '#0ECB81' : '#8b949e'} trailColor="rgba(255,255,255,0.08)" size="small" />
          </div>
        );
      })}
      <div className="text-[11px]">
        <span className="text-muted">配对减仓候选 </span>
        {exits.pair.candidate ? (
          <span className={exits.pair.candidate.allowed ? 'text-up' : 'text-warn'}>
            盈单 {exits.pair.candidate.profitLotId} + 亏单 {exits.pair.candidate.riskLotId}
            <span className="ml-1 text-[10px] text-muted">（{exits.pair.candidate.why}）</span>
          </span>
        ) : (
          <span className="text-muted">暂无达标对</span>
        )}
      </div>
      <div className="text-[11px]">
        <span className="text-muted">首单追踪 </span>
        {exits.firstTrail.active ? (
          <span className="text-up">已 arm（判定价回撤 1 格离场）</span>
        ) : exits.firstTrail.windowRemainBars != null && exits.firstTrail.windowRemainBars > 0 ? (
          <span className="num text-subtle">窗口剩 {exits.firstTrail.windowRemainBars} 根</span>
        ) : (
          <span className="text-muted">窗口外/无单</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 主组件

export function MartingaleV2Status({ st }: { st: StrategyRunStatus }) {
  const s = (st.state ?? {}) as unknown as V2State;
  const tickAgoSec = st.lastTickAt
    ? Math.max(0, Math.round((Date.now() - new Date(st.lastTickAt).getTime()) / 1000))
    : null;
  const tickStale = tickAgoSec !== null && tickAgoSec > 30;
  const dirText = !s.regime ? '' : s.regime.dir > 0 ? '粘滞偏多' : s.regime.dir < 0 ? '粘滞偏空' : '双向域';

  return (
    <Card size="small" title="运行状态 · V2 内核" className="!border-white/[0.06] !bg-white/[0.02]">
      {/* 状态带 */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {s.regime ? (
          <>
            <Tag color={stateTone(s.regime.state).color} className="!mr-0">
              {s.regime.stateText}
            </Tag>
            <span className="text-muted">
              dir <span className="num text-subtle">{s.regime.dir > 0 ? '+1' : s.regime.dir < 0 ? '-1' : '0'}</span>（{dirText}）
            </span>
            <span className="text-muted">
              chop <span className="num text-subtle">{s.regime.chop.toFixed(2)}</span> · 一致性{' '}
              <span className="num text-subtle">{pct(s.regime.coherence, 0)}</span>
            </span>
          </>
        ) : (
          <Tag className="!mr-0">内核关断态</Tag>
        )}
        <GateBadges gates={s.gates} />
        {boolOf(s.grid?.exposure.pivotAlarm) ? (
          <Tooltip title="pivot 警报：单侧深陷浮亏 + 持续逆行 → 已放行双侧 carry（不平老仓，对侧铺网格抗趋势）">
            <span className="chip border-warn/40 bg-warn/15 text-warn">carry</span>
          </Tooltip>
        ) : null}
      </div>
      {s.regime ? (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>score −100</span>
            <span className="num text-white">{s.regime.score > 0 ? '+' : ''}{s.regime.score.toFixed(1)}</span>
            <span>score +100</span>
          </div>
          <ScoreMeter score={s.regime.score} />
        </div>
      ) : null}

      {/* 三列（窄屏堆叠） */}
      <Row gutter={[16, 16]} className="mt-3 border-t border-white/[0.06] pt-3">
        <Col xs={24} md={8}>
          <div className="mb-2 text-[12px] font-medium text-white">市场理解</div>
          <RegimeColumn regime={s.regime} />
        </Col>
        <Col xs={24} md={8}>
          <div className="mb-2 text-[12px] font-medium text-white">网格</div>
          <GridColumn grid={s.grid} />
        </Col>
        <Col xs={24} md={8}>
          <div className="mb-2 text-[12px] font-medium text-white">出场</div>
          <ExitsColumn exits={s.exits} />
        </Col>
      </Row>

      {/* 心跳 + note + 错误（与老展示同款收尾） */}
      <div className="mt-3 flex items-center gap-1.5 border-t border-white/[0.06] pt-3 text-[11px]">
        <span className={tickStale ? 'text-down' : 'text-up'}>●</span>
        <span className={tickStale ? 'text-down' : 'text-subtle'}>
          {tickAgoSec === null
            ? '尚未产生心跳'
            : tickStale
              ? `心跳已停 ${tickAgoSec} 秒 —— 策略可能卡死，请查看错误信息`
              : `心跳正常（${tickAgoSec} 秒前 · 启动于 ${st.startedAt ? formatTime(st.startedAt) : '--'}）`}
        </span>
      </div>
      {s.note ? (
        <div className="mt-2 text-[12px] text-subtle">
          <span className="muted-text">最近动作：</span>
          {s.note}
        </div>
      ) : null}
      {st.lastError ? (
        <Alert className="mt-3" type="error" showIcon message="最近一次 tick 失败" description={st.lastError} />
      ) : null}
    </Card>
  );
}
