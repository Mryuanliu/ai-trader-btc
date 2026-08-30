import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { EXCHANGE_CODES, Environment, ExchangeCode } from '@ai-trader/shared';
import { ExchangeAccountService, UpsertExchangeAccountInput } from './exchange-account.service';
import { ExchangeRegistry } from './exchange-registry.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/business.exception';

@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: ExchangeAccountService,
    private readonly registry: ExchangeRegistry,
  ) {}

  /** 密钥只返回掩码，不返回明文 */
  @UseGuards(JwtAuthGuard)
  @Get()
  async list() {
    return this.accounts.list();
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':exchange')
  async upsert(
    @Param('exchange') exchange: string,
    @Body() body: UpsertExchangeAccountInput,
  ) {
    // 按枚举校验而非硬编码白名单：新增交易所后无需改动此处
    if (!EXCHANGE_CODES.includes(exchange as ExchangeCode)) {
      throw new BusinessException('BAD_REQUEST', '不支持的交易所');
    }
    const saved = await this.accounts.upsert({
      ...body,
      exchange: exchange as ExchangeCode,
      environment: body.environment as Environment,
    });
    this.registry.invalidate(exchange as ExchangeCode);
    return saved;
  }

  @UseGuards(JwtAuthGuard)
  @Post(':exchange/test')
  async test(@Param('exchange') exchange: string) {
    if (!EXCHANGE_CODES.includes(exchange as ExchangeCode)) {
      throw new BusinessException('BAD_REQUEST', '不支持的交易所');
    }
    this.registry.invalidate(exchange as ExchangeCode);
    return this.registry.probe(exchange as ExchangeCode);
  }
}
