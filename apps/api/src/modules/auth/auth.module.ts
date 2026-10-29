import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
@Module({ imports: [EmailModule], controllers: [AuthController, MfaController, UsersController], providers: [AuthService, MfaService, UsersService, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AuthModule {}
