import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { UserEntity } from '../database/entities';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly repo: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const username = this.config.get<string>('ADMIN_USERNAME', 'admin');
    const password = this.config.get<string>('ADMIN_PASSWORD', 'admin12345');
    const exists = await this.repo.findOne({ where: { username } });
    if (exists) return;

    await this.repo.save(
      this.repo.create({ username, passwordHash: bcrypt.hashSync(password, 10), role: 'admin' }),
    );
    this.logger.log(`已创建默认管理员账号 ${username}`);
  }

  async validate(username: string, password: string): Promise<UserEntity | null> {
    const user = await this.repo.findOne({
      where: { username },
      select: ['id', 'username', 'passwordHash', 'role'],
    });
    if (!user) return null;
    const ok = bcrypt.compareSync(password, user.passwordHash);
    return ok ? user : null;
  }

  async login(username: string, password: string) {
    const user = await this.validate(username, password);
    if (!user) return null;
    const payload = { sub: user.id, username: user.username, role: user.role };
    return {
      accessToken: this.jwt.sign(payload),
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '12h'),
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  async profile(userId: string) {
    const user = await this.repo.findOne({ where: { id: userId } });
    if (!user) return null;
    return { id: user.id, username: user.username, role: user.role };
  }
}
