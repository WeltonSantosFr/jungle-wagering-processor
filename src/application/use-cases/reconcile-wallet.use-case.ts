import { Inject, Injectable, Logger } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../ports/persistence.ports';
import { Money, MoneyProps } from '../../domain/value-objects/money.vo';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { ResourceNotFoundError } from './app-utils';

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    return this.uow.runInTransaction(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new ResourceNotFoundError('Wallet', walletId);
      }

      const entries = await ctx.ledger.findAllByWalletOrdered(walletId);
      let calculated = Money.zero(wallet.currency);

      for (const entry of entries) {
        if (entry.direction === LedgerDirection.Credit) {
          calculated = calculated.add(entry.money);
        } else {
          calculated = calculated.subtract(entry.money);
        }
      }

      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();

      if (!consistent) {
        this.logger.error({
          message: 'Wallet reconciliation divergence detected!',
          walletId: wallet.id,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          checkedEntries: entries.length,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}