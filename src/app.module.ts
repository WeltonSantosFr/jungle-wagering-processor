import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { dataSourceOptions } from './infrastructure/database/data-source';
import { SqsClientProvider } from './infrastructure/messaging/sqs/sqs.client';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true}),
    TypeOrmModule.forRoot(dataSourceOptions),
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService, SqsClientProvider],
  exports: [SqsClientProvider],
})
export class AppModule {}
