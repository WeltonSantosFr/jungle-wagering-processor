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

### 3.4 Estratégia de Testes de Domínio (Passo 4)
- A suíte unitária (`test/unit`) executa via `bun test` sem qualquer dependência de infraestrutura ou mocks de ORM, garantindo feedback em milissegundos sobre aritmética decimal, invariantes da `Wallet`, máquina de estados de `WagerTransaction`, inversão de direção contábil em `ROLLBACK` e determinismo do `payloadHash`.

## 4. Estratégia de Concorrência, Transação Atômica e Paginação (Passo 5)

### 4.1 Concorrência por `walletId` (Pessimistic Write Lock)
- **Decisão:** Adotamos **Pessimistic Locking ao nível da linha da carteira** (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`) dentro de `UnitOfWork.runInTransaction()`, combinado com incremento de `version` e constraints SQL.
- **Justificativa (Pessimistic vs. Optimistic em Hot Wallets):** Em plataformas de cassino (iGaming), um mesmo jogador ou rodada pode disparar múltiplas transações quase simultâneas sobre a mesma `walletId` (ex.: duas apostas concorrentes ou uma aposta seguida imediatamente de um resultado/rollback). Com *Optimistic Locking*, contendas legítimas geram falhas de versão (`OptimisticLockVersionMismatchError`), exigindo loops de retry na aplicação que aumentam a latência de cauda (p99) e o consumo de conexões. O `SELECT ... FOR UPDATE` no PostgreSQL enfileira e serializa apenas as transações que disputam **a mesma `walletId`**, permitindo que a segunda transação leia imediatamente o saldo atualizado assim que a primeira faz commit (ex.: no cenário de saldo 100 BRL com duas apostas de 80 BRL, a primeira aprova e deixa 20 BRL; a segunda adquire o lock em seguida, lê 20 BRL e rejeita deterministicamente com `INSUFFICIENT_FUNDS`). Operações em carteiras distintas ocorrem 100% em paralelo, sem lock global.

### 4.2 Concorrência nos Workers (Outbox e Pending Reference)
- Para suportar múltiplas instâncias da aplicação publicando a `Outbox` ou reprocessando `PENDING_REFERENCE` simultaneamente, utilizamos `SELECT ... FOR UPDATE SKIP LOCKED`. Linhas já bloqueadas por uma instância são ignoradas pelas demais, evitando contenção e disparos duplicados concorrentes.

### 4.3 Paginação por Cursor Estável e Opaco no Ledger
- O endpoint `GET /wallets/:walletId/ledger` utiliza *Keyset Pagination* sobre a tupla `(created_at, id)` codificada em `base64url`. Diferente de `OFFSET/LIMIT`, o cursor é imune a *page drift* e utiliza diretamente o índice composto `idx_ledger_wallet_cursor` em tempo constante $O(\log N)$.

## 5. Casos de Uso, Fluxo Transacional e Idempotência Concorrente (Passo 6)

### 5.1 Ordem de Aquisição de Lock e Prevenção de Race Conditions na Idempotência
No `ProcessWagerTransactionUseCase`, a ordem das operações dentro da transação SQL foi desenhada especificamente para suportar o cenário de **50 requisições paralelas idênticas** (Seção 13.1) sem gerar falsos erros 500:
1. Adquire-se **primeiro** o `SELECT ... FOR UPDATE` sobre a linha da `Wallet` (`findByIdForUpdate`).
2. Com o lock da carteira adquirido, consulta-se a existência da `WagerTransaction` por `idempotency_key` e por `(provider_id, external_transaction_id)`.
3. **Efeito prático:** Quando 50 requisições idênticas chegam no mesmo milissegundo, a 1ª trava a carteira, processa o débito, grava o `observed_balance` na transação e faz `COMMIT`. As outras 49 requisições, que aguardavam na fila do lock daquela carteira, entram uma a uma, encontram a transação já persistida no passo 2, validam o `payloadHash` e retornam imediatamente `idempotentReplay: true` com o `observed_balance` exato observado no momento da execução original.

### 5.2 Abertura de Carteira (`OPENING`) e Reconciliação
- Quando uma carteira é aberta com `initialBalance > 0.00`, o sistema gera atomicamente uma transação interna `kind = OPENING` (`PROCESSED`) e o respectivo lançamento `CREDIT` no Ledger. Isso garante que a invariante `wallet.balance == soma(ledger)` seja verdadeira desde o instante zero.
- O endpoint de reconciliação (`ReconcileWalletUseCase`) recalcula o saldo varrendo todo o histórico do Ledger da carteira e aponta qualquer divergência sem mascará-la ou sobrescrevê-la silenciosamente.

## 6. Camada HTTP e Tratamento Semântico de Exceções (Passo 7)

### 6.1 Mapeamento HTTP Status vs. Erros de Domínio
O `DomainExceptionFilter` intercepta todas as exceções de domínio e traduz para códigos HTTP semânticos exigidos pelo ecossistema de provedores iGaming:
- **`200/201 OK/Created`:** Sucesso ou replay idempotente válido.
- **`400 Bad Request` (`INVALID_PAYLOAD_OR_STATE`):** Erros de formatação de montante, moedas inválidas ou violação de máquina de estados.
- **`401 Unauthorized`:** Ponto de extensão reservado para o Auth Guard de IdP externo.
- **`404 Not Found` (`RESOURCE_NOT_FOUND`):** Carteiras ou transações inexistentes.
- **`409 Conflict` (`IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS`):** Conflito de payload na mesma `Idempotency-Key` ou duplicidade de carteira.
- **`422 Unprocessable Entity` (Códigos de falha específicos como `INSUFFICIENT_FUNDS`):** Rejeições por regras de negócio onde a requisição é sintaticamente correta, mas inviável no estado financeiro atual.