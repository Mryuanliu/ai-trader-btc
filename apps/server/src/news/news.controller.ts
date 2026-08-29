import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { NewsItemDTO, PageResult } from '@ai-trader/shared';
import { NewsService } from './news.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('news')
export class NewsController {
  constructor(private readonly news: NewsService) {}

  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('source') source?: string,
    @Query('keyword') keyword?: string,
  ): Promise<PageResult<NewsItemDTO>> {
    const result = await this.news.list({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      source,
      keyword,
    });
    return { ...result, page: Number(page) || 1, pageSize: Number(pageSize) || 20 };
  }

  @Get('sources')
  async sources() {
    return this.news.sources$();
  }

  @Get('keywords')
  async keywords(@Query('limit') limit?: string) {
    return this.news.keywordTrends(Number(limit) || 12);
  }

  /** 手动触发一次抓取 */
  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  async refresh(@Body() body: { simulatedOnly?: boolean }) {
    if (body?.simulatedOnly) {
      return { added: await this.news.seedSimulated(), simulated: true };
    }
    return this.news.fetchAll();
  }
}
