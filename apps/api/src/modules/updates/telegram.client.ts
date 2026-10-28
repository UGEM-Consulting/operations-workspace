import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TelegramUpdate {
 update_id: number;
 message?: { text?: string; chat: { id: number; type: string }; from?: { username?: string } };
}
/** A failure reduced to a safe code. Bot tokens appear in request URLs, so raw errors are never logged or returned. */
export class TelegramError extends Error {
 constructor(readonly code: string) { super(code); }
}
const REQUEST_TIMEOUT_MS = 10000;

/** Minimal Telegram Bot API client: read Start messages and send plain-text messages. */
@Injectable()
export class TelegramClient {
 private readonly token: string | null;
 readonly botUsername: string | null;
 private readonly base: string;
 constructor(config: ConfigService) {
  const enabled = config.get('TELEGRAM_DELIVERY') === 'bot';
  this.token = enabled ? config.get<string>('TELEGRAM_BOT_TOKEN') ?? null : null;
  this.botUsername = enabled ? config.get<string>('TELEGRAM_BOT_USERNAME') ?? null : null;
  this.base = config.get<string>('TELEGRAM_API_BASE') ?? 'https://api.telegram.org';
 }
 get enabled() { return this.token !== null && this.botUsername !== null; }
 private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  if (!this.token) throw new TelegramError('DISABLED');
  let response: Response;
  try {
   response = await fetch(`${this.base}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
  } catch (error) { throw new TelegramError(error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'); }
  const data = await response.json().catch(() => null) as { ok?: boolean; result?: T } | null;
  if (response.ok && data?.ok) return data.result as T;
  // 403: the user blocked the bot or never started it. 429: rate limited. Others are generic.
  throw new TelegramError(response.status === 403 ? 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'SERVER' : 'REJECTED');
 }
 getUpdates(offset: number, limit: number) { return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 0, limit, allowed_updates: ['message'] }); }
 sendMessage(chatId: string, text: string) { return this.call<unknown>('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }); }
}
