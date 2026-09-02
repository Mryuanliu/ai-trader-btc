import {
  FuturesAgentConfigEntity,
  AgentDecisionEntity,
  BalanceSnapshotEntity,
  ExchangeAccountEntity,
  MarketCandleEntity,
  FundingRateEntity,
  NewsItemEntity,
  OrderEntity,
  PositionLotEntity,
  RiskEventEntity,
  TradeFillEntity,
  UserEntity,
} from './index';

// 注：agent_configs（现货配置）与 balance_snapshots（现货快照）的表保留在库内，
// 但 AgentConfigEntity 实体已随现货链路移除，不再注册。
export const ALL_ENTITIES = [
  UserEntity,
  ExchangeAccountEntity,
  FuturesAgentConfigEntity,
  AgentDecisionEntity,
  OrderEntity,
  TradeFillEntity,
  PositionLotEntity,
  BalanceSnapshotEntity,
  MarketCandleEntity,
  FundingRateEntity,
  NewsItemEntity,
  RiskEventEntity,
];
