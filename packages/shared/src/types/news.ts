export interface NewsItemDTO {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  tags: string[];
  /** 被 Agent 决策引用次数 */
  citedCount: number;
  createdAt: string;
}

export interface KeywordTrend {
  keyword: string;
  count: number;
}
