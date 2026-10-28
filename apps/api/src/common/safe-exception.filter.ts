import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
const BODY_ERRORS: Record<number, string> = { 400: 'Invalid request body', 413: 'Request body too large', 415: 'Unsupported request body encoding' };
/** body-parser (http-errors) marks its own client errors with an entity.* or encoding type and a 4xx status. */
function bodyParserStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, type } = error as { status?: unknown; type?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string' && /^(entity|encoding|charset|request)\./.test(type) ? status : null;
}
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    // Request-body errors from the JSON parser (too large, malformed, unsupported encoding) are client errors: answer
    // with a fixed message, never the parser text, and do not log them as server failures.
    const parser = bodyParserStatus(error);
    if (parser) {
      response.status(parser).json({ statusCode: parser, message: BODY_ERRORS[parser] ?? 'Invalid request body' });
      return;
    }
    // Database/driver errors may include SQL parameters or session identifiers.
    Logger.error('Request failed; sensitive error details suppressed', 'HTTP');
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
