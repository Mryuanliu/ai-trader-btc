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
  /**
   * 交易所侧灾难保险丝总开关（见 docs/exchange-protection-orders-plan.md）。
   * off=全部新路径短路 no-op（默认，与现有行为零差异）；
   * fixed=开仓时挂一次不移动（Phase 1）；trailing=吊灯同步（Phase 2，后置）。
   */
  PROTECTION_MODE: 'off' | 'fixed' | 'trailing';
  /** 策略未声明灾难线时的兜底距离（%，相对开仓价） */
  PROTECTION_DEFAULT_PCT: number;
  /** I-1：灾难线亏损距离 ≥ 策略最近止损 × 该系数（不满足则收窄到 floor） */
  PROTECTION_FLOOR_RATIO: number;
  /** ProtectionReconciler 对账周期（秒） */
  PROTECTION_RECONCILE_SEC: number;
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
  /** 币安 U 本位合约账户（唯一交易所；现货已于 2026-08-31 移除，OKX 无实现） */
  BINANCE_FUTURES_ENABLED: boolean;
  BINANCE_FUTURES_API_KEY: string;
  BINANCE_FUTURES_API_SECRET: string;
  /** 合约账户环境：demo=模拟盘(合约 demo 即 testnet) live=实盘 */
  BINANCE_FUTURES_ENV: 'demo' | 'testnet' | 'live';
  HTTPS_PROXY: string;
  HTTP_PROXY: string;
  NO_PROXY: string;
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

  APP_RUN_MODE: Joi.string().valid('testnet', 'live').default('testnet'),

  // 交易所侧灾难保险丝（默认 off：新路径全部短路，不改现有行为）
  PROTECTION_MODE: Joi.string().valid('off', 'fixed', 'trailing').default('off'),
  PROTECTION_DEFAULT_PCT: Joi.number().default(5),
  PROTECTION_FLOOR_RATIO: Joi.number().default(1.2),
  PROTECTION_RECONCILE_SEC: Joi.number().default(300),

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

  // 币安 U 本位合约（唯一交易所；现货 2026-08-31 已移除，OKX 无实现）
  BINANCE_FUTURES_ENABLED: Joi.boolean().default(false),
  BINANCE_FUTURES_API_KEY: Joi.string().allow('').default(''),
  BINANCE_FUTURES_API_SECRET: Joi.string().allow('').default(''),
  BINANCE_FUTURES_ENV: Joi.string().valid('demo', 'testnet', 'live').default('demo'),

  HTTPS_PROXY: Joi.string().allow('').default(''),
  HTTP_PROXY: Joi.string().allow('').default(''),
  NO_PROXY: Joi.string().allow('').default(''),

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
