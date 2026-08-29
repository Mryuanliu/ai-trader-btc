import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeAccountEntity } from '../database/entities';
import { ExchangeAccountService } from './exchange-account.service';
import { ExchangeRegistry } from './exchange-registry.service';
import { AccountsController } from './accounts.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExchangeAccountEntity])],
  providers: [ExchangeAccountService, ExchangeRegistry],
  controllers: [AccountsController],
  exports: [ExchangeAccountService, ExchangeRegistry],
})
export class ExchangesModule {}
