import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './auth.dto';
import { AuthRequest, cookieName } from './session';
import { Public, Roles, STAFF, accessFor, requirePage } from './policy';
import { publicUser } from '../users/user.entity';
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}
  @Public() @Post('auth/login') @HttpCode(200)
  login(@Body() input: LoginDto, @Req() req: AuthRequest) { return this.auth.login(input, req); }
  @Roles(...STAFF) @Get('auth/me')
  me(@Req() req: AuthRequest) { return { user: publicUser(req.currentUser), ...accessFor(req.currentUser) }; }
  // Public to the session guard so an expired or disabled session can still be cleared. BFF and CSRF remain required.
  @Public() @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie(cookieName(this.config.get('NODE_ENV') === 'production'), { path: '/', httpOnly: true, sameSite: 'lax', secure: this.config.get('NODE_ENV') === 'production' });
  }
  @Roles(...STAFF) @Get('access/:page')
  access(@Req() req: AuthRequest, @Param('page') page: string) { requirePage(req.currentUser, page); return { allowed: true }; }
}
