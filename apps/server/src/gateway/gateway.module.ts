import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [MarketModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class GatewayModule {}
