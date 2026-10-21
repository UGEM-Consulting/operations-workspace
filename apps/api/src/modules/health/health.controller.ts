import { Public } from '../auth/policy';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
class HealthResponse {
  @ApiProperty({ example: 'ok' }) status!: string;
  @ApiProperty({ example: 'operations-api' }) service!: string;
  @ApiProperty({ example: 'connected' }) database!: string;
}
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DataSource) {}
  @Get()
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ description: 'Database is unavailable' })
  async check(): Promise<HealthResponse> {
    try { await this.database.query('SELECT 1'); }
    catch { throw new ServiceUnavailableException('Database unavailable'); }
    return { status: 'ok', service: 'operations-api', database: 'connected' };
  }
}
