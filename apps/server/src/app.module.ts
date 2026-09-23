import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ValidationPipe } from '@nestjs/common';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { ExchangesModule } from './exchanges/exchanges.module';
import { MarketModule } from './market/market.module';
import { NewsModule } from './news/news.module';
import { AccountModule } from './account/account.module';
import { AgentModule } from './agent/agent.module';
import { TradingModule } from './trading/trading.module';
import { FuturesModule } from './futures/futures.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { OverviewModule } from './overview/overview.module';
import { StrategyModule } from './strategy/strategy.module';
import { AllExceptionsFilter } from './common/all-exception.filter';

/**
 * 应用根模块（策略托管平台）。
 *
 * 平台只提供三件事：绑定交易所、下单交易、监控订单。
 * 交易逻辑全部由挂载的策略自行负责，平台不做任何风控；
 * 回测与决策引擎已移除。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // 同时支持从仓库根目录或 apps/server 目录启动
      envFilePath: [
        join(process.cwd(), '.env.local'),
        join(process.cwd(), '.env'),
        join(__dirname, '../../../.env.local'),
        join(__dirname, '../../../.env'),
      ],
      ignoreEnvFile: false,
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 300 },
      { name: 'write', ttl: 60_000, limit: 60 },
    ]),
    CommonModule,
    DatabaseModule,
    AuthModule,
    ExchangesModule,
    MarketModule,
    AccountModule,
    NewsModule,
    TradingModule,
    FuturesModule,
    AgentModule,
    OverviewModule,
    StrategyModule,
    GatewayModule,
    SchedulerModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: false,
        forbidNonWhitelisted: false,
      }),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
