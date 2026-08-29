import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities/all';

/**
 * TypeORM CLI 数据源，仅用于 migration:generate / migration:run
 * 注意：生产环境请把 DB_SYNCHRONIZE 设为 false 并统一走 migration
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USERNAME || 'ai_trader',
  password: process.env.DB_PASSWORD || 'ai_trader_pwd',
  database: process.env.DB_DATABASE || 'ai_trader',
  entities: ALL_ENTITIES,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: false,
});
// 注意：不要 default export——TypeORM CLI 要求文件中只有一个 DataSource 导出，双导出会让 migration:run 报错
