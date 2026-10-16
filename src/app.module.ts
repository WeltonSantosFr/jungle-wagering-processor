import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { dataSourceOptions } from './infrastructure/database/data-source';
import { SqsClientProvider } from './infrastructure/messaging/sqs/sqs.client';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UNIT_OF_WORK } from './application/ports/persistence.ports';
import { TypeOrmUnitOfWork } from './infrastructure/database/repositories/typeorm-unit-of-work';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { QueriesUseCase } from './application/use-cases/queries.use-case';
import { WageringController } from './presentation/http/controllers/wagering.controller';
import { WalletsController } from './presentation/http/controllers/wallets.controller';
import { APP_FILTER } from '@nestjs/core';
import { DomainExceptionFilter } from './presentation/http/filters/domain-exception.filter';
import { WagerSqsConsumer } from './infrastructure/messaging/sqs/wager-sqs.consumer';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/messaging/outbox/pending-service.worker';
import { HealthController } from './presentation/http/controllers/health.controller';
import { MetricsService } from './infrastructure/observability/metrics.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(dataSourceOptions),
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController, WalletsController, WageringController, HealthController],
  providers: [
    AppService,
    SqsClientProvider,
    { provide: UNIT_OF_WORK, useClass: TypeOrmUnitOfWork },
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    QueriesUseCase,
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
    WagerSqsConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    MetricsService,
  ],
  exports: [
    SqsClientProvider,
    UNIT_OF_WORK,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    QueriesUseCase,
    WagerSqsConsumer,
    MetricsService,
  ],
})
export class AppModule {}
