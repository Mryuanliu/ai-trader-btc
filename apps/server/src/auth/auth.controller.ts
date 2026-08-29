import { Body, Controller, Get, Post, Request, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: { username?: string; password?: string }) {
    if (!body?.username || !body?.password) {
      throw new UnauthorizedException('请输入用户名与密码');
    }
    const result = await this.auth.login(body.username, body.password);
    if (!result) throw new UnauthorizedException('用户名或密码错误');
    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async profile(@Request() req: { user: { userId: string } }) {
    return this.auth.profile(req.user.userId);
  }
}
