import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { StrategyDescriptor, StrategyManifest } from '@ai-trader/shared';
import { StrategyRegistry } from './strategy-registry.service';
import { BacktestService, type GateVerdict } from '../backtest/backtest.service';

/**
 * 策略包清单文件（manifest.json）的结构。
 *
 * 与 `StrategyManifest` 的关系：本结构是**磁盘上的文件格式**，
 * 除了清单元信息还带「上下架开关」与「可选覆盖的展示文案」。
 */
interface PackageManifest extends StrategyManifest {
  /** 与实现里的 name 对应 */
  name: string;
  /**
   * 清单所在的**目录名**（加载时记下，不写回文件）。
   *
   * 必须与 name 分开记：目录名常用连字符（`martingale-grid`），
   * 而策略名是下划线（`martingale_grid`）——用 name 拼路径会找不到文件，
   * 下架功能会静默失效（只在写回时暴露）。
   */
  dir: string;
  label?: string;
  description?: string;
  /** 上下架开关：false 则不出现在策略市场，也不允许启动 */
  enabled: boolean;
  defaultParams?: Record<string, unknown>;
  paramSchema?: Record<string, unknown>;
}

/**
 * 策略包目录。
 *
 * **基于模块自身位置定位，不用 `process.cwd()`**——
 * 服务的启动目录可能是项目根（`node apps/server/dist/main.js`），
 * 用 cwd 拼路径会找不到目录，导致「清单一直在但永远加载不到」。
 *
 * 本文件位于 `apps/server/{src,dist}/strategy/`，向上两级即 `apps/server/`，
 * 源码运行与编译产物运行都落在同一目录，测试与部署行为一致。
 */
function manifestDir(): string {
  return path.resolve(__dirname, '..', '..', 'strategies');
}

/**
 * 策略中心（P1）。
 *
 * 职责是把「策略元信息」从代码里搬出来：
 * - 上下架、版本、作者、能力声明、风险提示、默认参数都写进 `strategies/<name>/manifest.json`
 * - 改文案 / 下架 / 调默认参数**不需要改代码、不需要重新编译**
 * - 实现仍由代码注册（见 StrategyRegistry）——这是方案 A 的取舍：
 *   内部策略经过 code review 才合入，第三方动态加载留给 P4 沙箱
 */
@Injectable()
export class StrategyHub implements OnModuleInit {
  private readonly logger = new Logger(StrategyHub.name);
  private manifests = new Map<string, PackageManifest>();

  constructor(
    private readonly registry: StrategyRegistry,
    @Inject(forwardRef(() => BacktestService))
    private readonly backtestService: BacktestService,
  ) {}

  /** 启动时自动加载清单，避免首屏空市场 */
  onModuleInit() {
    void this.load().catch((err) => this.logger.warn(`策略包加载失败: ${err.message}`));
  }

  /** 扫描目录加载全部 manifest.json */
  async load(): Promise<{ found: number; enabled: number; missingImpl: string[] }> {
    const next = new Map<string, PackageManifest>();
    const missingImpl: string[] = [];

    let entries: string[] = [];
    try {
      entries = await fs.readdir(manifestDir());
    } catch {
      this.logger.warn(`策略目录不存在：${manifestDir()}`);
      this.manifests = next;
      return { found: 0, enabled: 0, missingImpl };
    }

    for (const entry of entries) {
      const file = path.join(manifestDir(), entry, 'manifest.json');
      try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw) as PackageManifest;
        if (!parsed?.name) {
          this.logger.warn(`清单缺少 name，跳过：${file}`);
          continue;
        }
        next.set(parsed.name, { ...parsed, dir: entry });
        // 实现缺失要显式暴露：清单写了但没有实现，属于「挂了牌子没货」
        if (!this.registry.get(parsed.name)) missingImpl.push(parsed.name);
      } catch (err) {
        this.logger.warn(`读取清单失败 ${file}: ${(err as Error).message}`);
      }
    }

    this.manifests = next;
    const enabled = [...next.values()].filter((m) => m.enabled !== false).length;
    this.logger.log(
      `策略包加载完成：发现 ${next.size} 个、上架 ${enabled} 个` +
        (missingImpl.length ? `、缺实现 ${missingImpl.join(',')}` : ''),
    );
    return { found: next.size, enabled, missingImpl };
  }

  /**
   * 上架列表：只返回「已启用」且「实现存在」的策略。
   *
   * 清单优先覆盖代码里的展示文案与默认参数——
   * 这样运营侧改一句话不必走一次编译发布。
   */
  list(): StrategyDescriptor[] {
    return this.registry
      .list()
      .filter((s) => {
        const m = this.manifests.get(s.name);
        // 没有清单的策略不上架：缺少版本与风险提示不允许出现在市场
        return m ? m.enabled !== false : false;
      })
      .map((s) => {
        const m = this.manifests.get(s.name);
        if (!m) return s;
        return {
          ...s,
          label: m.label ?? s.label,
          description: m.description ?? s.description,
          defaultParams: m.defaultParams ?? s.defaultParams,
          paramSchema: m.paramSchema ?? s.paramSchema,
          manifest: {
            version: m.version,
            author: m.author,
            capabilities: m.capabilities,
            riskNotes: m.riskNotes,
          },
        };
      });
  }

  /** 取某个策略（含清单）；未上架返回 undefined */
  get(name: string): StrategyDescriptor | undefined {
    return this.list().find((s) => s.name === name);
  }

  /** 是否允许启动（上架 + 有实现） */
  isAvailable(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** 上下架：写回 manifest.json 的 enabled 字段并重载；上架时前置闸门检查 */
  async setEnabled(
    name: string,
    enabled: boolean,
    opts?: { forceOverride?: { reason: string } },
  ): Promise<{ ok: boolean; message: string; gate?: GateVerdict }> {
    const existing = this.manifests.get(name);
    if (!existing) {
      return { ok: false, message: `未找到策略包清单：${name}` };
    }

    // 上架时检查闸门
    if (enabled) {
      const gate = await this.backtestService.hasPassingResearch(name);
      if (!gate.passed) {
        if (!opts?.forceOverride?.reason) {
          return {
            ok: false,
            message: `闸门未达：${gate.reasons.join('; ') || '无历史回测记录'}`,
            gate,
          };
        }
        // 强推上架：留痕 overrideReason
        this.logger.warn(`策略「${name}」闸门未达但强推上架，原因：${opts.forceOverride.reason}`);
      }
      // 写入 backtestRef
      existing.backtestRef = {
        runId: gate.runId ?? '',
        dsr: gate.dsr ?? 0,
        verdict: gate.passed ? 'pass' : 'overfit',
        ts: new Date().toISOString(),
        overrideReason: gate.passed ? undefined : opts?.forceOverride?.reason,
      };
    } else {
      existing.backtestRef = null;
    }

    const file = path.join(manifestDir(), existing.dir, 'manifest.json');
    try {
      // dir 是运行期记下的，不能写回清单文件（否则文件里多出无用字段）
      const { dir: _dir, ...writable } = existing;
      await fs.writeFile(
        file,
        `${JSON.stringify({ ...writable, enabled }, null, 2)}\n`,
        'utf8',
      );
      await this.load();
      return { ok: true, message: `策略「${name}」已${enabled ? '上架' : '下架'}` };
    } catch (err) {
      return { ok: false, message: `写入清单失败：${(err as Error).message}` };
    }
  }

  /** 当前已加载的清单（调试/诊断用） */
  loadedManifests(): PackageManifest[] {
    return [...this.manifests.values()];
  }
}
