-- 本地无 Docker 时的初始化脚本：在已运行的 PostgreSQL 实例上创建角色与数据库
-- 用法: psql -d postgres -h localhost -f scripts/init-db.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_trader') THEN
    CREATE ROLE ai_trader LOGIN PASSWORD 'ai_trader_pwd' CREATEDB;
  END IF;
END
$$;

SELECT 'CREATE DATABASE ai_trader OWNER ai_trader'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ai_trader')\gexec
