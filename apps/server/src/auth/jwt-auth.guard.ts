import { AuthGuard } from '@nestjs/passport';

/** 用于保护写操作与后台管理接口 */
export class JwtAuthGuard extends AuthGuard('jwt') {}
