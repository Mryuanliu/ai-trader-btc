import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBusService } from '../../common/events';
import { TradingJournalService } from '../trading-journal.service';

/**
 * 每日交易运行日志：验证「按天归档 + 决策去重 + 成交事件全模式记录」。
 * 用临时目录跑真实写盘（写队列是链式 promise，await 队尾即全部落定）。
 */
let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function makeJournal() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-'));
  process.env.TRADING_JOURNAL_DIR = dir;
  const events = new EventBusService();
  const journal = new TradingJournalService(events);
  journal.onModuleInit();
  return { events, journal };
}

const flush = (journal: TradingJournalService) =>
  (journal as unknown as { queue: Promise<void> }).queue;

async function onlyLogFile(): Promise<string> {
  const files = (await fs.readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f));
  expect(files.length).toBe(1);
  return path.join(dir, files[0]);
}

describe('TradingJournalService', () => {
  it('相同决策只落一次、变化才追加；文件按天命名', async () => {
    const { journal } = await makeJournal();
    journal.lifecycle('donchian_breakout:BTCUSDT', 'START', '周期=1h brk=80');
    journal.decision('i1', '价格在通道内，未突破');
    journal.decision('i1', '价格在通道内，未突破'); // 重复 -> 丢弃
    journal.decision('i1', '上破开 LONG');
    await flush(journal);

    const content = await fs.readFile(await onlyLogFile(), 'utf8');
    expect(content).toContain('| START |');
    expect(content.match(/未突破/g)?.length).toBe(1); // 去重生效
    expect(content).toContain('上破开 LONG');
  });

  it('lotOpened 事件被记录（testnet）', async () => {
    const { events, journal } = await makeJournal();
    events.emit('lotOpened', {
      symbol: 'BTCUSDT',
      market: 'futures',
      direction: 'LONG',
      quantity: 0.001,
      entryPrice: 63000,
      fee: 0.04,
      strategyInstanceId: 'donchian_breakout:BTCUSDT',
      source: 'strategy',
      mode: 'testnet',
      ts: Date.now(),
    });
    await flush(journal);

    const content = await fs.readFile(await onlyLogFile(), 'utf8');
    expect(content).toContain('| OPEN |');
    expect(content).toContain('testnet');
  });
});
