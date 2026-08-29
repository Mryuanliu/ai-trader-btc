import {
  AgentConfigEntity,
  AgentDecisionEntity,
  BalanceSnapshotEntity,
  ExchangeAccountEntity,
  MarketCandleEntity,
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
  AgentDecisionEntity,
  OrderEntity,
  TradeFillEntity,
  BalanceSnapshotEntity,
  MarketCandleEntity,
  NewsItemEntity,
  RiskEventEntity,
];
