import {
  AgentConfigEntity,
  FuturesAgentConfigEntity,
  AgentDecisionEntity,
  BalanceSnapshotEntity,
  ExchangeAccountEntity,
  MarketCandleEntity,
  FundingRateEntity,
  NewsItemEntity,
  OrderEntity,
  RiskEventEntity,
  TradeFillEntity,
  UserEntity,
} from './index';

export const ALL_ENTITIES = [
  UserEntity,
  ExchangeAccountEntity,
  AgentConfigEntity,
  FuturesAgentConfigEntity,
  AgentDecisionEntity,
  OrderEntity,
  TradeFillEntity,
  BalanceSnapshotEntity,
  MarketCandleEntity,
  FundingRateEntity,
  NewsItemEntity,
  RiskEventEntity,
];
