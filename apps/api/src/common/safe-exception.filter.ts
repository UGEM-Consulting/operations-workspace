import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
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
    // Database/driver errors may include SQL parameters or session identifiers.
    Logger.error('Request failed; sensitive error details suppressed', 'HTTP');
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
