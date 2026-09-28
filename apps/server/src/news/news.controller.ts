import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CalendarEventDTO, NewsItemDTO, PageResult } from '@ai-trader/shared';
import { NewsService } from './news.service';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('news')
export class NewsController {
  constructor(
    private readonly news: NewsService,
    private readonly calendar: CalendarService,
  ) {}

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
  async refresh() {
    return this.news.fetchAll();
  }

  /** 财经日历：美联储议息 / 非农 / CPI 等宏观事件（ForexFactory 数据源） */
  @Get('calendar')
  async calendarList(@Query('impact') impact?: string) {
    return this.calendar.list(impact);
  }

  /** 手动触发日历刷新 */
  @UseGuards(JwtAuthGuard)
  @Post('calendar/refresh')
  async refreshCalendar() {
    return this.calendar.refresh();
  }
}
