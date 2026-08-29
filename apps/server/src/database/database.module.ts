import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from './entities/all';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const synchronize =
          config.get<string>('DB_SYNCHRONIZE', 'true') === 'true' ||
          (config.get<string>('NODE_ENV') !== 'production' &&
            config.get<string>('DB_SYNCHRONIZE') !== 'false');

        if (synchronize) {
          new Logger('Database').warn(
            'DB_SYNCHRONIZE=true，启动时将自动同步表结构（生产环境请关闭并改用 migration）',
          );
        }

        return {
          type: 'postgres',
          host: config.get<string>('DB_HOST', 'localhost'),
          port: Number(config.get<string>('DB_PORT', '5432')),
          username: config.get<string>('DB_USERNAME', 'ai_trader'),
          password: config.get<string>('DB_PASSWORD', 'ai_trader_pwd'),
          database: config.get<string>('DB_DATABASE', 'ai_trader'),
          entities: ALL_ENTITIES,
          migrations: [__dirname + '/migrations/*.{ts,js}'],
          synchronize,
          migrationsRun: false,
          logging: config.get<string>('DB_LOGGING', 'false') === 'true',
          maxQueryExecutionTime: 1000,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
