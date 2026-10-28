import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { TelegramClient } from './telegram.client';
import { UpdatesService } from './updates.service';
@Module({ imports: [EmailModule], providers: [UpdatesService, TelegramClient], exports: [UpdatesService] })
export class UpdatesModule {}
