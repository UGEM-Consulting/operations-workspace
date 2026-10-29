import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { Role } from '../users/user.entity';
import { CreateJobTitleDto, CreateMcDto, ListQueryDto, UpdateJobTitleDto, UpdateMcDto } from './lists.dto';
import { ListsService } from './lists.service';

@Controller('lists')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER)
class ListsController {
 constructor(private readonly lists: ListsService) {}
 @Get('mcs') mcs(@Query() query: ListQueryDto) { return this.lists.list('MC', query.status); }
 @Post('mcs') createMc(@Req() req: AuthRequest, @Body() dto: CreateMcDto) { return this.lists.create(req.currentUser, 'MC', dto); }
 @Patch('mcs/:id') updateMc(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMcDto) { return this.lists.update(req.currentUser, 'MC', id, dto); }
 @Get('job-titles') jobTitles(@Query() query: ListQueryDto) { return this.lists.list('JOB_TITLE', query.status); }
 @Post('job-titles') createJobTitle(@Req() req: AuthRequest, @Body() dto: CreateJobTitleDto) { return this.lists.create(req.currentUser, 'JOB_TITLE', dto); }
 @Patch('job-titles/:id') updateJobTitle(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJobTitleDto) { return this.lists.update(req.currentUser, 'JOB_TITLE', id, dto); }
}
@Module({ controllers: [ListsController], providers: [ListsService], exports: [ListsService] })
export class ListsModule {}
