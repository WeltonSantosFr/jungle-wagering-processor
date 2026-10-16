import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case';
import { QueriesUseCase } from '../../../application/use-cases/queries.use-case';
import { AuthGuard } from '../filters/guards/auth.guard';
import { MoneyProps } from '../../../domain/value-objects/money.vo';

class CreateWalletDto {
  playerId: string;
  initialBalance: MoneyProps;
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    private readonly queriesUseCase: QueriesUseCase,
  ) {}

  @Post()
  async createWallet(@Body() dto: CreateWalletDto) {
    return this.createWalletUseCase.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
    });
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    return this.queriesUseCase.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.queriesUseCase.getWalletLedger(walletId, limit, cursor);
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}