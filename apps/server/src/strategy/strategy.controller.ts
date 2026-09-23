import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';
import { StrategyRunner } from './strategy-runner.service';

/**
 * 策略接口：合集列表、运行状态、启动/停止。
 *
 * 启动会被拦下并返回具体未平仓位单清单——上一个策略留下的仓位
 * 必须先手动了结，否则两套策略的仓位会混在一起无法归因。
 */
@Controller('strategy')
@UseGuards(JwtAuthGuard)
export class StrategyController {
  constructor(private readonly runner: StrategyRunner) {}

  /** 策略合集（卡片页） */
  @Get()
  list() {
    return this.runner.list();
  }

  /** 当前运行状态 */
  @Get('status')
  status() {
    return this.runner.getStatus();
  }

  /** 启动策略：name + 可选 params（params 会经 normalizeParams 归一化） */
  @Post('start')
  async start(@Body() body: { name?: string; params?: Record<string, unknown> }) {
    if (!body?.name) {
      throw new BusinessException('BAD_REQUEST', '缺少策略名 name');
    }
    const result = await this.runner.start(body.name, body.params);
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
}
