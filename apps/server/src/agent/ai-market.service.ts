import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiMarketAnalysis } from '@ai-trader/shared';
import { atr, ema } from '@ai-trader/shared';
import { LlmClient } from './llm.client';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';

/** 分析结果缓存时长：行情/新闻变化不快，避免前端重复点击打爆模型额度 */
const CACHE_MS = 60_000;
/** 送入 prompt 的新闻条数 */
const NEWS_LIMIT = 12;

const SYSTEM_PROMPT = [
  '你是一名加密货币市场分析师，负责解读行情并给出市场状态判断。',
  '你**不提供交易指令**——只做市场解读，具体买卖由交易策略自行决定。',
  '严格输出 JSON，不要输出多余文字，格式：',
  '{"regime":"trending|ranging|volatile","regimeConfidence":0~1,"aggression":0~1,',
  '"newsSentiment":-1~1,"positionView":"positive|neutral|negative","comment":"一句话点评(≤60字)"}',
].join('\n');

/**
 * AI 行情分析服务。
 *
 * 平台唯一使用大模型的地方：输入行情 + 新闻，输出「市场状态」这类解读性信息。
 * 输出**不进入任何下单路径**——策略是否交易与这里无关。
 *
 * 失败不抛异常：模型不可用时返回 ok=false + 本地指标，前端照样能展示客观行情。
 */
@Injectable()
export class AiMarketService {
  private readonly logger = new Logger(AiMarketService.name);
  private readonly cache = new Map<string, { at: number; data: AiMarketAnalysis }>();

  constructor(
    private readonly llm: LlmClient,
    private readonly market: MarketService,
    private readonly news: NewsService,
    private readonly config: ConfigService,
  ) {}

  async analyze(symbol: string, force = false): Promise<AiMarketAnalysis> {
    const cached = this.cache.get(symbol);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) {
      return cached.data;
    }

    const local = await this.buildLocalSnapshot(symbol);
    const base = { ...local, generatedAt: new Date().toISOString() };

    if (!this.llm.available) {
      const data: AiMarketAnalysis = {
        ...base,
        regime: null,
        regimeConfidence: null,
        aggression: null,
        newsSentiment: null,
        positionView: null,
        comment: null,
        reasoning: null,
        model: null,
        ok: false,
        error: '未配置大模型（LLM_API_KEY），仅展示本地行情指标',
      };
      this.cache.set(symbol, { at: Date.now(), data });
      return data;
    }

    try {
      const newsList = await this.news.list({ pageSize: NEWS_LIMIT });
      const headlines = newsList.items
        .slice(0, NEWS_LIMIT)
        .map((n, i) => `${i + 1}. ${n.title}`)
        .join('\n');

      const user = [
        `交易对：${symbol}`,
        `最新价：${local.price}`,
        `24h 涨跌幅：${local.changePercent24h.toFixed(2)}%`,
        `ATR14(1h)：${local.atr.toFixed(2)}`,
        `价格相对 30 周期均线偏离：${local.maDeviationPct.toFixed(2)}%`,
        '',
        '近期新闻标题：',
        headlines || '（暂无新闻）',
        '',
        '请基于以上信息判断当前市场状态并输出 JSON。',
      ].join('\n');

      const result = await this.llm.analyzeContext(
        SYSTEM_PROMPT,
        user,
        this.config.get<string>('LLM_MODEL', 'deepseek-chat'),
        Number(this.config.get<string>('LLM_TEMPERATURE', '0.3')),
        Number(this.config.get<string>('LLM_MAX_TOKENS', '800')),
      );

      const insight = result.insight;
      const data: AiMarketAnalysis = {
        ...base,
        newsCount: newsList.items.length,
        regime: insight?.regime ?? null,
        regimeConfidence: insight?.regimeConfidence ?? null,
        aggression: insight?.aggression ?? null,
        newsSentiment: insight?.newsSentiment ?? null,
        positionView: insight?.positionView ?? null,
        comment: insight?.comment ?? null,
        reasoning: result.reasoning ?? null,
        model: result.model ?? null,
        ok: Boolean(insight),
        error: insight ? null : (result.error ?? '模型输出无法解析'),
      };
      this.cache.set(symbol, { at: Date.now(), data });
      return data;
    } catch (err) {
      const data: AiMarketAnalysis = {
        ...base,
        newsCount: 0,
        regime: null,
        regimeConfidence: null,
        aggression: null,
        newsSentiment: null,
        positionView: null,
        comment: null,
        reasoning: null,
        model: null,
        ok: false,
        error: (err as Error).message,
      };
      this.logger.warn(`AI 行情分析失败：${data.error}`);
      this.cache.set(symbol, { at: Date.now(), data });
      return data;
    }
  }

  /**
   * 本地客观指标：这部分不依赖 AI，模型不可用时依然可展示。
   * 数据源是平台的 K 线存储（1h），与策略看到的行情同源。
   */
  private async buildLocalSnapshot(symbol: string): Promise<{
    symbol: string;
    price: number;
    changePercent24h: number;
    atr: number;
    maDeviationPct: number;
    newsCount: number;
  }> {
    let price = 0;
    let changePercent24h = 0;
    try {
      const ticker = this.market.getTicker(symbol);
      price = ticker?.price ?? 0;
      changePercent24h = ticker?.changePercent24h ?? 0;
    } catch {
      /* 行情不可用时按 0 处理，前端会显示 -- */
    }

    let atrValue = 0;
    let maDeviationPct = 0;
    try {
      const candles = this.market.getCandles(symbol, '1h', 120);
      if (candles.length >= 30) {
        const closes = candles.map((c) => c.close);
        const a = atr(
          candles.map((c) => c.high),
          candles.map((c) => c.low),
          closes,
          14,
        );
        atrValue = Number.isFinite(a) ? a : 0;
        const ma = ema(closes, 30);
        const last = closes[closes.length - 1];
        if (Number.isFinite(ma) && ma > 0) {
          maDeviationPct = ((last - ma) / ma) * 100;
        }
      }
    } catch {
      /* 忽略：本地指标缺失不影响流程 */
    }

    return { symbol, price, changePercent24h, atr: atrValue, maDeviationPct, newsCount: 0 };
  }
}
