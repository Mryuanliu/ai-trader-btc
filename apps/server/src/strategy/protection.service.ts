import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ProtectionsConfig } from '@ai-trader/shared';
import { BasketEntity } from '../database/entities/basket.entity';
import { FuturesConfigService } from '../futures/futures-config.service';

/** 熔断评估结论 */
export interface ProtectionVerdict {
  /** 是否命中判据（需要停实例） */
  halt: boolean;
  /** 命中原因（连亏 / 回撤）；未命中为空串 */
  reason: string;
  /** 尾部连续亏损篮数 */
  consecutiveLosses: number;
  /** 已实现权益相对峰值的最大回撤百分比 */
  drawdownPct: number;
}

const NO_HALT: ProtectionVerdict = {
  halt: false,
  reason: '',
  consecutiveLosses: 0,
  drawdownPct: 0,
};

/**
 * 平台侧熔断评估器（D4）。
 *
 * 定位：这是「策略自己没设好止损时的平台级最后兜底」——**生命周期守卫**，
 * 不是策略风控。命中判据时只由 Runner 调 `stopInstance` 停实例，
 * **绝不平仓、不碰下单/仓位/出场逻辑**，以保持策略自治。
 *
 * 单向依赖：只依赖 Basket 仓储 + 配置服务，**不依赖 Runner**（避免循环）。
 * Runner 订阅 `basketClosed` 事件后调 `evaluate()` 拿结论，自行决定停哪个实例。
 *
 * 评价单元 = **篮子（Basket）**，与 `computePerformance` 完全一致：
 * 马丁加层中间浮亏无意义，整轮了结（CLOSED 篮子）才算「一笔」。
 * 每篮净收益 `net = realizedPnl + fundingFee`（同 shared `pnlOf` 口径）。
 */
@Injectable()
export class ProtectionService {
  constructor(
    @InjectRepository(BasketEntity)
    private readonly basketRepo: Repository<BasketEntity>,
    private readonly futuresConfig: FuturesConfigService,
  ) {}

  /** 读熔断配置（toShape 已归一化，脏数据也拿不到非法值） */
  async getConfig(): Promise<ProtectionsConfig> {
    const cfg = await this.futuresConfig.get();
    return cfg.protections;
  }

  /**
   * 评估某运行实例是否触发熔断。
   *
   * 判据一 · 连亏 N 笔：尾部（closedAt 最新方向往前）连续 `net ≤ 0` 的篮数 ≥ 阈值。
   * 判据二 · 回撤超阈：重建已实现权益曲线 `equity = capitalBase + Σnet`（升序累计），
   *   `peak` 为运行最大值，取整条曲线的**最大回撤** `dd% = max((peak−equity)/peak×100)`；≥ 阈值命中。
   *   `capitalBaseUsdt` 抬高 peak 下限，规避累计权益为负时的除零/口径失真。
   *
   * 只统计 `strategyInstanceId === 本实例` 的 CLOSED 篮子（多实例隔离，互不误伤）。
   * `lookbackBaskets>0` 时只取最近 N 篮评估（窗口外的历史亏损不计）。
   * 未启用 / 无篮子 → 直接短路不触发。
   */
  async evaluate(instanceId: string): Promise<ProtectionVerdict> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return NO_HALT;

    let baskets = await this.basketRepo.find({
      where: { status: 'CLOSED', strategyInstanceId: instanceId },
      order: { closedAt: 'ASC' },
    });
    if (cfg.lookbackBaskets > 0) baskets = baskets.slice(-cfg.lookbackBaskets);
    if (baskets.length === 0) return NO_HALT;

    // decimal 列 TypeORM 返回 string，须 Number() 转换（与 performance.service 一致）
    const nets = baskets.map((b) => Number(b.realizedPnl) + Number(b.fundingFee));

    // 判据一：尾部连续亏损（net ≤ 0 视为未盈利）
    let consecutiveLosses = 0;
    for (let i = nets.length - 1; i >= 0; i--) {
      if (nets[i] <= 0) consecutiveLosses += 1;
      else break;
    }

    // 判据二：已实现权益曲线最大回撤
    let equity = cfg.capitalBaseUsdt;
    let peak = cfg.capitalBaseUsdt;
    let drawdownPct = 0;
    for (const net of nets) {
      equity += net;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      drawdownPct = Math.max(drawdownPct, dd);
    }

    const reasons: string[] = [];
    if (consecutiveLosses >= cfg.maxConsecutiveLosses) {
      reasons.push(`连亏 ${consecutiveLosses} 笔（阈值 ${cfg.maxConsecutiveLosses}）`);
    }
    if (drawdownPct >= cfg.maxDrawdownPct) {
      reasons.push(`回撤 ${drawdownPct.toFixed(2)}%（阈值 ${cfg.maxDrawdownPct}%）`);
    }

    const halt = reasons.length > 0;
    return {
      halt,
      reason: reasons.join('；'),
      consecutiveLosses,
      drawdownPct,
    };
  }
}
