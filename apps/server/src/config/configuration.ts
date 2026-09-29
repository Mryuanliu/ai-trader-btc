import * as Joi from 'joi';
import { RunMode } from '@ai-trader/shared';

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  APP_MASTER_KEY: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_DATABASE: string;
  DB_SYNCHRONIZE: boolean;
  DB_LOGGING: boolean;
  APP_RUN_MODE: RunMode;
  // 注：LIVE_TRADING_CONFIRM_TOKEN 已移除——实盘二次确认改为前端弹窗
  LLM_ENABLED: boolean;
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  LLM_TEMPERATURE: number;
  LLM_MAX_TOKENS: number;
  LLM_TIMEOUT_MS: number;
  /** 通用对话（LlmChatService）：模型/超时/工具循环上限，与 analyzeContext 分离 */
  LLM_CHAT_MODEL: string;
  LLM_CHAT_TIMEOUT_MS: number;
  LLM_MAX_TOOL_ROUNDS: number;
  /** MCP server 列表（JSON 数组），留空不启用 */
  MCP_SERVERS: string;
  /** Agent Skills 目录，留空自动探测 src/dist 旁挂 skills/ */
  SKILLS_DIR: string;
  BINANCE_ENABLED: boolean;
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  /** 币安账户环境：demo=模拟盘 testnet=测试网 live=实盘 */
  BINANCE_ENV: 'demo' | 'testnet' | 'live';
  /** 保留旧变量名做向后兼容，仅当 BINANCE_ENV 未显式设置时生效 */
  BINANCE_TESTNET: boolean;
  /** 币安 U 本位合约账户（demo 环境可复用现货 key） */
  BINANCE_FUTURES_ENABLED: boolean;
  BINANCE_FUTURES_API_KEY: string;
  BINANCE_FUTURES_API_SECRET: string;
  /** 合约账户环境：demo=模拟盘(合约 demo 即 testnet) live=实盘 */
  BINANCE_FUTURES_ENV: 'demo' | 'testnet' | 'live';
  HTTPS_PROXY: string;
  HTTP_PROXY: string;
  NO_PROXY: string;
  OKX_ENABLED: boolean;
  OKX_API_KEY: string;
  OKX_API_SECRET: string;
  OKX_PASSPHRASE: string;
  OKX_TESTNET: boolean;
  NEWS_ENABLED: boolean;
  NEWS_FETCH_INTERVAL_SEC: number;
  NEWS_SOURCES: string;
  CORS_ORIGIN: string;
  // 飞书推送（自建应用 + SDK）：订单成交/结束主动推送到指定群
  FEISHU_PUSH_ENABLED: boolean;
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  /** 推送目标群 chat_id（把机器人拉进群后获取） */
  FEISHU_CHAT_ID: string;
  // 飞书对话机器人（长连接收消息 + LLM 工具循环），与推送开关独立
  FEISHU_BOT_ENABLED: boolean;
  /** 白名单群（逗号分隔 chat_id），留空默认 = FEISHU_CHAT_ID；名单外完全静默 */
  FEISHU_BOT_ALLOWED_CHATS: string;
  /** 可选：事件加密/验签（长连接模式下一般不需要） */
  FEISHU_ENCRYPT_KEY: string;
  FEISHU_VERIFICATION_TOKEN: string;
}

export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3001),
  APP_MASTER_KEY: Joi.string().default('change-me-32-bytes-master-key-please'),
  JWT_SECRET: Joi.string().default('change-me-jwt-secret'),
  JWT_EXPIRES_IN: Joi.string().default('12h'),
  ADMIN_USERNAME: Joi.string().default('admin'),
  ADMIN_PASSWORD: Joi.string().default('admin12345'),

  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().default('ai_trader'),
  DB_PASSWORD: Joi.string().default('ai_trader_pwd'),
  DB_DATABASE: Joi.string().default('ai_trader'),
  DB_SYNCHRONIZE: Joi.boolean().default(true),
  DB_LOGGING: Joi.boolean().default(false),

  APP_RUN_MODE: Joi.string().valid('dry_run', 'testnet', 'live').default('dry_run'),

  LLM_ENABLED: Joi.boolean().default(true),
  LLM_BASE_URL: Joi.string().default('https://api.deepseek.com'),
  LLM_API_KEY: Joi.string().allow('').default(''),
  LLM_MODEL: Joi.string().default('deepseek-chat'),
  LLM_TEMPERATURE: Joi.number().default(0.2),
  LLM_MAX_TOKENS: Joi.number().default(800),
  LLM_TIMEOUT_MS: Joi.number().default(30000),

  LLM_CHAT_MODEL: Joi.string().default('deepseek-chat'),
  LLM_CHAT_TIMEOUT_MS: Joi.number().default(45000),
  LLM_MAX_TOOL_ROUNDS: Joi.number().default(6),
  MCP_SERVERS: Joi.string().allow('').default(''),
  SKILLS_DIR: Joi.string().allow('').default(''),

  BINANCE_ENABLED: Joi.boolean().default(false),
  BINANCE_API_KEY: Joi.string().allow('').default(''),
  BINANCE_API_SECRET: Joi.string().allow('').default(''),
  // 默认 demo：币安官方已用模拟交易（Demo Mode）取代旧测试网作为主流验证环境
  BINANCE_ENV: Joi.string().valid('demo', 'testnet', 'live').default('demo'),
  // 旧开关，仅用于 BINANCE_ENV 未显式配置时推断
  BINANCE_TESTNET: Joi.boolean().default(true),

  // 币安 U 本位合约：留空时交易所账户层会自动回退复用 BINANCE_API_KEY/SECRET
  // （demo 环境已实测同一 key 现货与合约通用），实盘可显式配置独立合约 key
  BINANCE_FUTURES_ENABLED: Joi.boolean().default(false),
  BINANCE_FUTURES_API_KEY: Joi.string().allow('').default(''),
  BINANCE_FUTURES_API_SECRET: Joi.string().allow('').default(''),
  BINANCE_FUTURES_ENV: Joi.string().valid('demo', 'testnet', 'live').default('demo'),

  HTTPS_PROXY: Joi.string().allow('').default(''),
  HTTP_PROXY: Joi.string().allow('').default(''),
  NO_PROXY: Joi.string().allow('').default(''),

  OKX_ENABLED: Joi.boolean().default(false),
  OKX_API_KEY: Joi.string().allow('').default(''),
  OKX_API_SECRET: Joi.string().allow('').default(''),
  OKX_PASSPHRASE: Joi.string().allow('').default(''),
  OKX_TESTNET: Joi.boolean().default(true),

  NEWS_ENABLED: Joi.boolean().default(true),
  NEWS_FETCH_INTERVAL_SEC: Joi.number().default(900),
  NEWS_SOURCES: Joi.string().default(''),

  CORS_ORIGIN: Joi.string().default('http://localhost:5173'),

  // 缺 APP_ID/SECRET/CHAT_ID 时飞书推送整体 no-op；ENABLED 作总开关
  FEISHU_PUSH_ENABLED: Joi.boolean().default(true),
  FEISHU_APP_ID: Joi.string().allow('').default(''),
  FEISHU_APP_SECRET: Joi.string().allow('').default(''),
  FEISHU_CHAT_ID: Joi.string().allow('').default(''),

  // 对话机器人默认关：需要飞书后台先开启「长连接」并订阅 im.message.receive_v1 再打开
  FEISHU_BOT_ENABLED: Joi.boolean().default(false),
  FEISHU_BOT_ALLOWED_CHATS: Joi.string().allow('').default(''),
  FEISHU_ENCRYPT_KEY: Joi.string().allow('').default(''),
  FEISHU_VERIFICATION_TOKEN: Joi.string().allow('').default(''),
}).unknown(true);

export default () => {
  const { value, error } = envSchema.validate(process.env, {
    abortEarly: false,
    allowUnknown: true,
    stripUnknown: false,
    convert: true,
  });
  if (error) {
    throw new Error(`环境变量校验失败: ${error.details.map((d) => d.message).join('; ')}`);
  }
  return value as AppEnv;
};
