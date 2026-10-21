import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
@Module({ controllers: [AuthController, UsersController], providers: [AuthService, UsersService, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AuthModule {}
