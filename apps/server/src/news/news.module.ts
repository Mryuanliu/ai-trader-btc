import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NewsItemEntity } from '../database/entities';
import { NewsService } from './news.service';
import { CalendarService } from './calendar.service';
import { NewsController } from './news.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NewsItemEntity])],
  providers: [NewsService, CalendarService],
  controllers: [NewsController],
  exports: [NewsService, CalendarService],
})
export class NewsModule {}
