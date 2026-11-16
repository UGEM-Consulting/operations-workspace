import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { AccountQueryDto, AddSeatDto, ChangeSeatDto, CreateAccountDto, UpdateAccountDto } from './load-boards.dto';
import { LoadBoardsService } from './load-boards.service';

// IT and administrators keep the load board accounts and seats; dispatch managers read them (section 33).
const KEEPERS = [Role.SYSTEM_ADMIN, Role.IT_SPECIALIST];
@Controller()
@Roles(...KEEPERS)
class LoadBoardsController {
 constructor(private readonly loadBoards: LoadBoardsService) {}
 @Get('lists/load-board-accounts') @Roles(...KEEPERS, Role.DISPATCHER_MANAGER) accounts(@Query() query: AccountQueryDto) { return this.loadBoards.accounts(query.status); }
 @Get('lists/load-board-accounts/:id') @Roles(...KEEPERS, Role.DISPATCHER_MANAGER) account(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.loadBoards.account(id, req.currentUser); }
 @Post('lists/load-board-accounts') createAccount(@Req() req: AuthRequest, @Body() dto: CreateAccountDto) { return this.loadBoards.createAccount(req.currentUser, dto); }
 @Patch('lists/load-board-accounts/:id') updateAccount(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAccountDto) { return this.loadBoards.updateAccount(req.currentUser, id, dto); }
 @Get('load-board-seats/people') people() { return this.loadBoards.people(); }
 @Post('load-board-seats') addSeat(@Req() req: AuthRequest, @Body() dto: AddSeatDto) { return this.loadBoards.addSeat(req.currentUser, dto); }
 @Post('load-board-seats/:id') changeSeat(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeSeatDto) { return this.loadBoards.changeSeat(req.currentUser, id, dto); }
}
@Module({ controllers: [LoadBoardsController], providers: [LoadBoardsService], exports: [LoadBoardsService] })
export class LoadBoardsModule {}
