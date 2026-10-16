import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import { QueriesUseCase } from '../../../application/use-cases/queries.use-case';
import { AuthGuard } from '../filters/guards/auth.guard';
import { WagerTransactionKind } from '../../../domain/entities/wager-transaction.entity';
import { MoneyProps } from '../../../domain/value-objects/money.vo';
import { DomainError } from '../../../domain/errors/domain.errors';

class SubmitTransactionDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase,
    private readonly queriesUseCase: QueriesUseCase,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: SubmitTransactionDto,
  ) {
    if (!idempotencyKey) {
      throw new DomainError(
        "Missing required HTTP header 'Idempotency-Key'",
        'MISSING_IDEMPOTENCY_KEY',
      );
    }

    return this.processWagerTxUseCase.execute({
      idempotencyKey,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });
  }

  @Get('wagering/transactions/:transactionId')
  async getTransactionById(@Param('transactionId') transactionId: string) {
    return this.queriesUseCase.getTransactionById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queriesUseCase.getTransactionByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}