import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from './user.entity';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto } from './users.dto';
@Roles(Role.SYSTEM_ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get() list() { return this.users.list(); }
  @Post() create(@Body() dto: CreateUserDto) { return this.users.create(dto); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Req() req: AuthRequest) { return this.users.update(id, dto, req.currentUser); }
}
