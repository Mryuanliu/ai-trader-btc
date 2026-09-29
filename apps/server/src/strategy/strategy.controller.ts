import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DEFAULT_SYMBOL } from '@ai-trader/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';
import { StrategyRunner } from './strategy-runner.service';
import { PerformanceService } from './performance.service';
import { StrategyHub } from './strategy-hub.service';

/**
 * 策略接口：合集列表、运行状态、启动/停止。
 *
 * 启动会被拦下并返回具体未平仓位单清单——上一个策略留下的仓位
 * 必须先手动了结，否则两套策略的仓位会混在一起无法归因。
 */
@Controller('strategy')
@UseGuards(JwtAuthGuard)
export class StrategyController {
  constructor(
    private readonly runner: StrategyRunner,
    private readonly perf: PerformanceService,
    private readonly hub: StrategyHub,
  ) {}

  /**
   * 策略合集（卡片页）。
   *
   * 经 Hub 过滤：只返回**已上架**且**实现存在**的策略——
   * 下架或缺失实现的不会出现在市场里。
   */
  @Get()
  list() {
    return this.hub.list();
  }

  /** 热重载策略包：重新扫描 strategies/ 目录（上新/下架后不必重启服务） */
  @Post('reload')
  reload() {
    return this.hub.load();
  }

  /** 上下架：改写 manifest.json 的 enabled 并重载；上架触发闸门 */
  @Post(':name/enabled')
  async setEnabled(
    @Param('name') name: string,
    @Body() body: { enabled?: boolean; forceOverride?: { reason: string } },
  ) {
    const result = await this.hub.setEnabled(name, body?.enabled !== false, {
      forceOverride: body?.forceOverride,
    });
    if (!result.ok) {
      throw new BusinessException('BAD_REQUEST', result.message);
    }
    return result;
  }

  /** 当前运行状态 */
  @Get('status')
  status() {
    return this.runner.getStatus();
  }

  /**
   * 启动策略：name + 可选 params（会经 normalizeParams 归一化）。
   *
   * `adoptExisting=true` 表示接管现有的未完结仓位单（服务重启后恢复运行用），
   * 否则有未平仓单时会被拦下并返回明细。
   */
  @Post('start')
  async start(
    @Body()
    body: {
      name?: string;
      /** 可选：指定交易对启动新实例（P2 多实例）；缺省用平台配置的默认币种 */
      symbol?: string;
      params?: Record<string, unknown>;
      adoptExisting?: boolean;
    },
  ) {
    if (!body?.name) {
      throw new BusinessException('BAD_REQUEST', '缺少策略名 name');
    }
    // 未上架（清单缺失或 enabled=false）的策略不允许启动
    if (!this.hub.isAvailable(body.name)) {
      throw new BusinessException(
        'BAD_REQUEST',
        `策略「${body.name}」未上架或缺少实现，无法启动`,
      );
    }
    // 传了 symbol → 启动独立实例（`策略名:交易对`）；没传 → 兼容旧语义（默认币种）
    const result = body.symbol
      ? await this.runner.startInstance(body.name, body.symbol, body.params, {
          adoptExisting: body.adoptExisting === true,
        })
      : await this.runner.start(body.name, body.params, {
          adoptExisting: body.adoptExisting === true,
        });
    if (!result.ok && !result.blockingLots) {
      throw new BusinessException('BAD_REQUEST', result.message);
    }
    // 被未平仓单拦下时返回 200 + 详情，前端弹窗列出这些仓位单
    return result;
  }

  /** 停止策略（不自动平仓，持仓保留由用户处理） */
  @Post('stop')
  stop() {
    return this.runner.stop();
  }

  /** 策略绩效：按已了结篮子聚合的收益/回撤/夏普等指标 */
  @Get('performance')
  performance(
    @Query('name') name?: string,
    @Query('symbol') symbol?: string,
    @Query('window') win?: string,
  ) {
    const window = (win === '7d' || win === '30d' ? win : 'all') as '7d' | '30d' | 'all';
    return this.perf.compute(name ?? 'manual', symbol ?? DEFAULT_SYMBOL, window);
  }

  /** 排行榜：所有策略在指定窗口内的绩效 */
  @Get('leaderboard')
  leaderboard(
    @Query('symbol') symbol?: string,
    @Query('window') win?: string,
  ) {
    const window = (win === '7d' || win === 'all' ? win : '30d') as '7d' | '30d' | 'all';
    return this.perf.leaderboard(symbol ?? DEFAULT_SYMBOL, window);
  }

  /**
   * 一键平仓：平掉当前篮子的全部持仓，**策略继续运行**并自动开始下一轮挂单。
   *
   * 与 stop 的区别：stop 是「不再交易」（保留持仓），
   * 这里是「了结当前这一轮」（平掉持仓后继续跑）。
   */
  @Post('close-basket')
  closeBasket() {
    return this.runner.closeBasket();
  }
}
