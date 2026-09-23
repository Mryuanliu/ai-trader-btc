import {
  BasketEntity,
  ExchangeIncomeEntity,
  FuturesAgentConfigEntity,
  ExchangeAccountEntity,
  MarketCandleEntity,
  NewsItemEntity,
  OrderEntity,
  PositionLotEntity,
  TradeFillEntity,
  UserEntity,
} from './index';

// 注：agent_configs / agent_decisions / risk_events / balance_snapshots / funding_rates
// 的表已删除（迁移 1700000013000-DropDeadTables），不再注册。
export const ALL_ENTITIES = [
  UserEntity,
  ExchangeAccountEntity,
  FuturesAgentConfigEntity,
  BasketEntity,
  ExchangeIncomeEntity,
  OrderEntity,
  TradeFillEntity,
  PositionLotEntity,
  MarketCandleEntity,
  NewsItemEntity,
];
