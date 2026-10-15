import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { WalletOrmEntity } from './entities/wallet.orm-entity';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from './entities/wallet-ledger-entry.orm-entity';
import { InboxMessageOrmEntity } from './entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from './entities/outbox-message.orm-entity';
import { InitialSchema1700000000000 } from './migrations/1700000000000-InitialSchema';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'wagering_db',
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerEntryOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
  ],
  migrations: [InitialSchema1700000000000],
  synchronize: false,
  logging: false,
};

export const AppDataSource = new DataSource(dataSourceOptions);