/**
 * 种子数据：写入默认 Agent 配置、交易所账户占位记录与示例新闻，
 * 让新环境启动后立刻能看到完整的决策链路演示数据。
 *
 * 用法：pnpm --filter @ai-trader/server seed
 */
import 'dotenv/config';
import { AppDataSource } from './data-source';
import { AgentConfigEntity, ExchangeAccountEntity, NewsItemEntity } from './entities';
import { DEFAULT_AGENT_CONFIG } from '@ai-trader/shared';

const SEED_NEWS = [
  {
    title: '比特币现货 ETF 单周净流入 12.4 亿美元，机构配置需求延续',
    summary:
      '上周比特币现货 ETF 合计净流入 12.4 亿美元，其中贝莱德 IBIT 与富达 FBTC 贡献主要增量，机构配置需求延续。',
    source: 'CoinDesk',
    tags: ['比特币', 'ETF', '机构'],
  },
  {
    title: '美联储会议纪要偏鹰，交易员下调年内降息预期至一次',
    summary: '纪要显示多数委员认为通胀回落路径仍不稳固，市场对年内降息次数的定价已降至一次。',
    source: 'Cointelegraph',
    tags: ['美联储', '降息'],
  },
  {
    title: '链上数据：交易所 BTC 余额降至五年低位，筹码持续向冷钱包转移',
    summary: '交易所 BTC 余额已降至近五年低位，大量筹码转入长期持有地址，短期可流通供给趋紧。',
    source: 'CryptoQuant',
    tags: ['链上', 'BTC'],
  },
  {
    title: '全网 24 小时合约爆仓 3.2 亿美元，其中多单占比 68%',
    summary: '过去 24 小时全网合约爆仓 3.2 亿美元，多头杠杆在高位被集中清洗，市场杠杆结构有所改善。',
    source: 'The Block',
    tags: ['清算', '爆仓'],
  },
  {
    title: 'Bitcoin 全网算力突破 780 EH/s，挖矿难度创历史新高',
    summary: '全网算力突破 780 EH/s，下一次难度调整预计上调约 3.1%，矿工竞争持续加剧。',
    source: 'Bitcoin Magazine',
    tags: ['算力', '矿工'],
  },
  {
    title: '稳定币总市值单月增加 42 亿美元，USDT 市占率回升至 71%',
    summary: '稳定币总市值单月增加 42 亿美元，增量资金通常被视为风险资产的潜在弹药。',
    source: 'Bloomberg Crypto',
    tags: ['稳定币', 'USDT'],
  },
];

async function main() {
  await AppDataSource.initialize();
  console.log('数据库连接成功，开始写入种子数据…');

  // 1. Agent 配置
  const agentRepo = AppDataSource.getRepository(AgentConfigEntity);
  let agent = await agentRepo.findOne({ where: {}, order: { createdAt: 'ASC' } });
  if (!agent) {
    agent = agentRepo.create({
      ...DEFAULT_AGENT_CONFIG,
      mode: (process.env.APP_RUN_MODE as AgentConfigEntity['mode']) ?? 'dry_run',
    });
    await agentRepo.save(agent);
    console.log('✓ 已创建默认 Agent 配置');
  } else {
    console.log('· Agent 配置已存在，跳过');
  }

  // 2. 交易所账户占位
  const accountRepo = AppDataSource.getRepository(ExchangeAccountEntity);
  for (const [code, label] of [
    ['binance', '币安 Binance'],
    ['okx', '欧意 OKX'],
  ] as const) {
    const exists = await accountRepo.findOne({ where: { exchange: code } });
    if (exists) {
      console.log(`· ${label} 账户记录已存在，跳过`);
      continue;
    }
    await accountRepo.save(
      accountRepo.create({
        exchange: code,
        label,
        environment: 'testnet',
        enabled: false,
        lastMessage: '未配置密钥，仅可用于公共行情',
      }),
    );
    console.log(`✓ 已创建 ${label} 账户占位记录`);
  }

  // 3. 示例新闻
  const newsRepo = AppDataSource.getRepository(NewsItemEntity);
  let added = 0;
  const now = Date.now();
  for (let i = 0; i < SEED_NEWS.length; i += 1) {
    const item = SEED_NEWS[i];
    const url = `seed://news/${i}`;
    const exists = await newsRepo.findOne({ where: { url } });
    if (exists) continue;
    await newsRepo.save(
      newsRepo.create({
        title: item.title,
        summary: item.summary,
        url,
        source: item.source,
        publishedAt: new Date(now - (i + 1) * 47 * 60_000),
        tags: item.tags,
      }),
    );
    added += 1;
  }
  console.log(`✓ 已写入 ${added} 条示例新闻`);

  await AppDataSource.destroy();
  console.log('种子数据写入完成');
}

main().catch((err) => {
  console.error('种子数据写入失败:', err);
  process.exit(1);
});
