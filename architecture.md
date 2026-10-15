# Arquitetura e Decisões Técnicas — Distributed Wagering Processor

## 1. Fundação, Runtime e Infraestrutura (Passo 1)

### 1.1 Escolha do ORM: TypeORM vs. MikroORM
Optou-se pelo **TypeORM** pelos seguintes motivos técnicos e de produtividade:
- **Controle explícito de transações e locks:** Uso direto de `DataSource.transaction()` e `QueryRunner` com suporte nativo a `pessimistic_write` (`SELECT ... FOR UPDATE`) e queries brutas otimizadas (`FOR UPDATE SKIP LOCKED` para o Outbox).
- **Desacoplamento total do Domínio:** As entidades de domínio (`src/domain`) são classes TypeScript puras, sem decorators do ORM. A persistência utiliza entidades separadas (`*.orm-entity.ts`) convertidas por `Mappers` explícitos via métodos estáticos `.rehydrate()`, eliminando os efeitos colaterais de magia de ORM sobre as invariantes de negócio.
- **Migrations determinísticas:** As migrations utilizam DDL SQL explícito para declarar constraints complexas (`CHECK`, `UNIQUE` parciais e Triggers de imutabilidade) que ORMs costumam abstrair de forma incompleta.

### 1.2 Topologia de Mensageria (AWS SQS FIFO + DLQ)
A infraestrutura local utiliza **LocalStack** provisionando três filas FIFO:
- `wager-transactions.fifo`: Fila de entrada com `ContentBasedDeduplication=false` (a deduplicação definitiva é garantida pelo banco via *Transactional Inbox*, não apenas pelo broker).
- `wager-transactions-dlq.fifo`: Dead-Letter Queue vinculada via `RedrivePolicy` com `maxReceiveCount = 3` para isolar falhas permanentes ou payloads corrompidos após esgotamento de retries transitórios.
- `wagering-events.fifo`: Fila de destino para publicação assíncrona dos eventos de integração pelo *Transactional Outbox Worker*.

## 2. Modelagem do Schema e Garantias no Banco de Dados (Passo 2)

Em conformidade com a Restrição 5.9, todas as invariantes críticas de domínio são blindadas diretamente no schema do PostgreSQL:

- **Precisão Monetária (`NUMERIC(20, 2)`):** Nenhum valor financeiro utiliza `FLOAT` ou `DOUBLE PRECISION`. O driver `pg` entrega valores `NUMERIC` como `string`, preservando a representação exata até a hidratação da classe `Money`.
- **Invariantes da Wallet:**
  - `uq_wallets_player_currency`: `UNIQUE (player_id, currency)` garante no máximo uma carteira por jogador e moeda.
  - `chk_wallets_balance_non_negative`: `CHECK (balance >= 0.00)` impede saldo negativo mesmo sob race conditions extremas.
- **Idempotência e Unicidade de Transações:**
  - `uq_wager_tx_idempotency_key` (`UNIQUE (idempotency_key)`) e `uq_wager_tx_provider_external` (`UNIQUE (provider_id, external_transaction_id)`).
  - `uq_wager_tx_single_processed_reversal`: Índice único parcial (`WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`) que impede no nível do banco que uma mesma transação de referência seja revertida mais de uma vez.
- **Imutabilidade e Matemática do Ledger:**
  - `uq_ledger_transaction_id`: `UNIQUE (transaction_id)` garante no máximo 1 lançamento contábil por transação.
  - `chk_ledger_arithmetic`: `CHECK` constraint que valida na escrita que `balance_before + amount = balance_after` (em créditos) e `balance_before - amount = balance_after` (em débitos).
  - `trg_immutable_ledger`: Trigger `BEFORE UPDATE OR DELETE` em `wallet_ledger_entries` que bloqueia mutações ou exclusões de registros contábeis no banco.
- **Índices Operacionais:**
  - `idx_outbox_unpublished`: Índice parcial (`WHERE published_at IS NULL`) otimizado para varredura com `FOR UPDATE SKIP LOCKED`.
  - `idx_ledger_wallet_cursor`: Índice composto `(wallet_id, created_at ASC, id ASC)` para paginação determinística por cursor opaco.

  ## 3. Modelo de Domínio, Precisão Monetária e Idempotência (Passo 3)

### 3.1 Representação de `Money`
- Implementado como Value Object imutável encapsulando `decimal.js`.
- **Validação de Fronteira:** Aceita exclusivamente strings decimais que respeitem a expressão regular `/^\d+\.\d{2}$/` e códigos de moeda ISO-4217 (`/^[A-Z]{3}$/`). Entradas com `NaN`, `Infinity`, notação científica (`1e5`), valores negativos ou escala diferente de 2 casas decimais lançam `InvalidMoneyError` imediatamente.
- **Operações Seguras:** `add`, `subtract` e `isLessThan` exigem a mesma moeda (`assertSameCurrency`), lançando `CurrencyMismatchError` em caso de divergência.

### 3.2 Algoritmo de `payloadHash` Canónico
- Para distinguir *idempotent replay* de *idempotency conflict* (mesma `Idempotency-Key` com payload adulterado), calculamos um hash **SHA-256** sobre a representação JSON canónica (chaves de objetos ordenadas recursivamente em ordem alfabética) contendo exclusivamente os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.{amount, currency}` e `referenceExternalTransactionId`. Metadados HTTP ou headers de transporte ficam de fora.

### 3.3 Máquina de Estados de `WagerTransaction` e Taxonomia de `FailureCode`
- Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) são protegidos por `assertNotTerminal()`: qualquer tentativa de mutação posterior lança `InvalidTransactionStateError`.
- Diferenciação explícita entre falta de saldo numa aposta (`INSUFFICIENT_FUNDS`) e reversão (`ROLLBACK` de `WIN`/`REFUND`) que deixaria a carteira negativa (`REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`), atendendo à Regra 9 da Seção 7.