import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const SqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    return new SQSClient({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: config.get<string>('AWS_ENDPOINT', 'http://localhost:4566'),
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY', 'test'),
      },
    });
  },
};