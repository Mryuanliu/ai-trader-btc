import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // 剥离未在 DTO 中声明的字段，避免无关或恶意字段透传到业务层。
      // 不启用 forbidNonWhitelisted：前端可能携带后端未跟进的字段，
      // 直接报 400 会让旧版本前端无法兼容，静默剥离更稳妥。
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT || 3001);
  await app.listen(port, '0.0.0.0');
  logger.log(`后端服务已启动: http://localhost:${port}/api`);
  logger.log(`WebSocket 已启动: ws://localhost:${port}/realtime`);
}

void bootstrap();
