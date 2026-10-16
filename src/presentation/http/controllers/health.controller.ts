import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../../../infrastructure/messaging/sqs/sqs.client';
import { MetricsService } from '../../../infrastructure/observability/metrics.service';

@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly metricsService: MetricsService,
  ) {}

  @Get('health/live')
  getLiveness() {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/ready')
  async getReadiness() {
    const checks: Record<string, string> = {
      postgres: 'DOWN',
      sqs: 'DOWN',
    };

    try {
      await this.dataSource.query('SELECT 1');
      checks.postgres = 'UP';
    } catch {
      checks.postgres = 'DOWN';
    }

    try {
      await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
      checks.sqs = 'UP';
    } catch {
      checks.sqs = 'DOWN';
    }

    const isReady = checks.postgres === 'UP' && checks.sqs === 'UP';
    const payload = {
      status: isReady ? 'UP' : 'DOWN',
      checks,
      timestamp: new Date().toISOString(),
    };

    if (!isReady) {
      throw new HttpException(payload, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return payload;
  }

  @Get('metrics')
  async getMetrics() {
    return this.metricsService.getSnapshot();
  }
}