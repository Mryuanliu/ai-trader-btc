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
import { ExecutionModule } from './execution/execution.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { OverviewModule } from './overview/overview.module';
import { BacktestModule } from './backtest/backtest.module';
import { AllExceptionsFilter } from './common/all-exception.filter';

/**
 * 应用根模块（仅合约交易）。
 *
 * `AgentModule` 只提供决策内核（L0~L3：指标/策略/链路分派/AI 上下文），
 * 消费者是合约引擎 FuturesEngine；现货引擎与现货配置已移除。
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
    ExecutionModule,
    AgentModule,
    OverviewModule,
    BacktestModule,
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
