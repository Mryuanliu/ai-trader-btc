import { HttpException, HttpStatus } from '@nestjs/common';

export type BusinessCode =
  | 'RISK_REJECTED'
  | 'EXCHANGE_NOT_CONFIGURED'
  | 'EXCHANGE_ERROR'
  | 'LIVE_MODE_CONFIRM_REQUIRED'
  | 'AGENT_BUSY'
  | 'NOT_FOUND'
  | 'BAD_REQUEST';

const STATUS_MAP: Record<BusinessCode, HttpStatus> = {
  RISK_REJECTED: HttpStatus.FORBIDDEN,
  EXCHANGE_NOT_CONFIGURED: HttpStatus.BAD_REQUEST,
  EXCHANGE_ERROR: HttpStatus.BAD_GATEWAY,
  LIVE_MODE_CONFIRM_REQUIRED: HttpStatus.FORBIDDEN,
  AGENT_BUSY: HttpStatus.CONFLICT,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  BAD_REQUEST: HttpStatus.BAD_REQUEST,
};

export class BusinessException extends HttpException {
  readonly code: BusinessCode;

  constructor(code: BusinessCode, message: string) {
    super({ code, message }, STATUS_MAP[code] ?? HttpStatus.BAD_REQUEST);
    this.code = code;
  }
}
