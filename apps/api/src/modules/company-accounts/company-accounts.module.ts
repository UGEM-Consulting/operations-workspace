import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { TaskUpdateDto } from '../it/it.dto';
import { AccountRequestsService } from './account-requests';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AccountContactDto, AddCompanyAccountDto, CloseCompanyAccountDto, UpdateCompanyAccountDto } from './company-accounts.dto';
import { CompanyAccountsService } from './company-accounts.service';

// After a file records them, only IT and administrators change accounts at other companies (section 33).
@Controller('company-accounts')
@Roles(Role.SYSTEM_ADMIN, Role.IT_SPECIALIST)
class CompanyAccountsController {
 constructor(private readonly accounts: CompanyAccountsService, private readonly requests: AccountRequestsService) {}
 // Asking IT to close one (CloseCompanyAccountScreen) is for dispatch managers and administrators.
 @Post(':id/close') @Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER) close(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseCompanyAccountDto) { return this.requests.askToClose(req.currentUser, id, dto); }
 @Post() add(@Req() req: AuthRequest, @Body() dto: AddCompanyAccountDto) { return this.accounts.add(req.currentUser, dto); }
 @Patch(':id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyAccountDto) { return this.accounts.update(req.currentUser, id, dto); }
}
// IT's checklist for an account request (ItCloseAccountTaskScreen, and a move's new accounts).
@Controller('it/accounts')
@Roles(Role.SYSTEM_ADMIN, Role.IT_SPECIALIST)
class AccountRequestsController {
 constructor(private readonly requests: AccountRequestsService) {}
 @Get(':id') detail(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.requests.detail(req.currentUser, id); }
 @Patch(':id/contact') contact(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AccountContactDto) { return this.requests.contact(req.currentUser, id, dto); }
 @Patch(':id/tasks/:key') task(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() dto: TaskUpdateDto) { return this.requests.task(req.currentUser, id, key, dto); }
}
@Module({ controllers: [CompanyAccountsController, AccountRequestsController], providers: [CompanyAccountsService, AccountRequestsService], exports: [CompanyAccountsService, AccountRequestsService] })
export class CompanyAccountsModule {}
