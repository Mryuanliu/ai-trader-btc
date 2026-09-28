import { Module } from '@nestjs/common';
import { FeishuService } from './feishu.service';
import { FeishuNotificationService } from './feishu-notification.service';

/**
 * 飞书推送模块。
 *
 * EventBusService（CommonModule @Global）与 ConfigService（ConfigModule isGlobal）
 * 均为全局提供，本模块无需显式 imports。
 */
@Module({
  providers: [FeishuService, FeishuNotificationService],
  exports: [FeishuService],
})
export class FeishuModule {}
