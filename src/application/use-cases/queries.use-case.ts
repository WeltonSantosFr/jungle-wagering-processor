import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../ports/persistence.ports';
import { ResourceNotFoundError } from './app-utils';

@Injectable()
export class QueriesUseCase {
  constructor(
    @Inject(UNIT_OF_WORK)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async getWallet(walletId: string) {
    const wallet = await this.uow.repositories.wallets.findById(walletId);
    if (!wallet) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async getWalletLedger(walletId: string, limit = 50, cursor?: string) {
    const wallet = await this.uow.repositories.wallets.findById(walletId);
    if (!wallet) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }

    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const page = await this.uow.repositories.ledger.findByWalletPaginated(
      walletId,
      safeLimit,
      cursor,
    );

    return {
      walletId,
      items: page.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getTransactionById(transactionId: string) {
    const tx = await this.uow.repositories.transactions.findById(transactionId);
    if (!tx) {
      throw new ResourceNotFoundError('WagerTransaction', transactionId);
    }
    return this.serializeTransaction(tx);
  }

  async getTransactionByProviderAndExternalId(providerId: string, externalTransactionId: string) {
    const tx = await this.uow.repositories.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new ResourceNotFoundError(
        'WagerTransaction',
        `${providerId}:${externalTransactionId}`,
      );
    }
    return this.serializeTransaction(tx);
  }

  private serializeTransaction(tx: Awaited<ReturnType<typeof this.uow.repositories.transactions.findById>> & object) {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      observedBalance: tx.observedBalance ? tx.observedBalance.toJSON() : null,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
    };
  }
}