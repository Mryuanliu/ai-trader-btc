import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentConfigEntity } from '../database/entities';
import { AgentConfigService } from './agent-config.service';

/** 单独成模块，避免 AgentModule 与 TradingModule 循环依赖 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentConfigEntity])],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
