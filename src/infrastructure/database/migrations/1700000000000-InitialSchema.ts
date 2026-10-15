import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Wallets
    await queryRunner.query(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0.00),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
      );
    `);

    // 2. Wager Transactions
    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(150) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id UUID NOT NULL,
        round_id VARCHAR(150) NOT NULL,
        game_id VARCHAR(150) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(150) NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        status VARCHAR(30) NOT NULL,
        failure_code VARCHAR(60) NULL,
        retry_count INT NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        observed_balance NUMERIC(20, 2) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_tx_amount_non_negative CHECK (amount >= 0.00),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
      );

      -- Impede que uma mesma transação de referência seja revertida duas vezes com sucesso (Seção 7 - Regra 4)
      CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;

      -- Índice para o worker de PENDING_REFERENCE buscar pendências rapidamente
      CREATE INDEX idx_wager_tx_pending_ref
        ON wager_transactions (next_retry_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE INDEX idx_wager_tx_wallet_id ON wager_transactions (wallet_id);
    `);

    // 3. Wallet Ledger Entries (Imutável)
    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_ledger_transaction_id UNIQUE (transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0.00),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0.00 AND balance_after >= 0.00),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );

      -- Índice composto para paginação eficiente por cursor e reconciliação
      CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at ASC, id ASC);

      -- Trigger para garantir imutabilidade estrita no banco (Seção 5.5 e 5.9)
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable: UPDATE and DELETE are strictly forbidden';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_immutable_ledger
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    // 4. Inbox Messages
    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(150) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages
    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ NULL
      );

      -- Índice parcial para o polling com FOR UPDATE SKIP LOCKED
      CREATE INDEX idx_outbox_unpublished
        ON outbox_messages (next_attempt_at ASC, occurred_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS inbox_messages;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_immutable_ledger ON wallet_ledger_entries;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_ledger_mutation;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wager_transactions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets;`);
  }
}