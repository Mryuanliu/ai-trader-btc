import { Global, Module } from '@nestjs/common';
import { EventBusService } from './events';

@Global()
@Module({
  providers: [EventBusService],
  exports: [EventBusService],
})
export class CommonModule {}
