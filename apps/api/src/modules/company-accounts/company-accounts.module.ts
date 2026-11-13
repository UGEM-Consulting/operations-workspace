import { Body, Controller, Module, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AddCompanyAccountDto, UpdateCompanyAccountDto } from './company-accounts.dto';
import { CompanyAccountsService } from './company-accounts.service';

// After a file records them, only IT and administrators change accounts at other companies (section 33).
@Controller('company-accounts')
@Roles(Role.SYSTEM_ADMIN, Role.IT_SPECIALIST)
class CompanyAccountsController {
 constructor(private readonly accounts: CompanyAccountsService) {}
 @Post() add(@Req() req: AuthRequest, @Body() dto: AddCompanyAccountDto) { return this.accounts.add(req.currentUser, dto); }
 @Patch(':id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyAccountDto) { return this.accounts.update(req.currentUser, id, dto); }
}
@Module({ controllers: [CompanyAccountsController], providers: [CompanyAccountsService], exports: [CompanyAccountsService] })
export class CompanyAccountsModule {}
