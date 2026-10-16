# Distributed Wagering Processor — Jungle Gaming Challenge 🦧

Serviço financeiro distribuído para processamento de transações de apostas (iGaming) construído com **Bun 1.x**, **NestJS**, **TypeScript (Strict Mode)**, **TypeORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

> 📄 **Documentação Arquitetural:** Todas as justificativas técnicas exigidas no desafio (escolha do ORM, modelagem do `Money`, estratégia de Pessimistic Locking por `walletId`, algoritmo de `payloadHash`, taxonomia de `FailureCode`, desenho de Autenticação com IdP externo, trade-offs e análise do teste de carga) estão detalhadas em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## 1. Pré-requisitos

- **Bun** `>= 1.1` (`bun --version`)
- **Docker** e **Docker Compose** (`docker compose version`)

---

## 2. Setup e Execução (Passo a Passo)

### 2.1. Instalar dependências e configurar variáveis de ambiente
```bash
bun install
cp .env.example .env
```

Nota sobre portas: Por padrão, a API sobe na porta definida em PORT no arquivo .env (padrão 3000 ou 3002). O PostgreSQL utiliza a porta 5432 e o LocalStack a porta 4566.

### 2.2. Subir a infraestrutura (PostgreSQL 16+ LocalStack SQS FIFO)
```bash
chmod +x docker/localstack-init.sh
docker compose up -d
```

Aguarde alguns segundos até que ambos os containers estejam com status `healthy`:
```bash
docker compose ps
```

O script docker/localstack-init.sh provisiona automaticamente no LocalStack as 3 filas FIFO exigidas:
- `wager-transactions.fifo` (Fila principal de entrada com `RedrivePolicy` de `maxReceiveCount = 3`)
- `wager-transactions-dlq.fifo` (Dead-Letter Queue)
- `wagering-events.fifo` (Fila de destino dos eventos publicados pelo Transactional Outbox)

Para confirmar que as filas foram criadas:
```bash
docker exec wagering_localstack awslocal sqs list-queues
```

### 2.3. Executar as Migrations (DDL, Constraints e Triggers)
As migrations são versionadas e reversíveis, aplicando todas as constraints (`CHECK`, `UNIQUE`, índices parciais) e a trigger `trg_immutable_ledger` diretamente no PostgreSQL:
```bash
# Aplicar migrations
bun run migration:run

# (Opcional) Testar reversibilidade e reaplicar
bun run migration:revert
bun run migration:run
```

### 2.4. Iniciar a aplicação
```bash
# Modo desenvolvimento (watch mode)
bun run start:dev

# Modo produção
bun run build
bun run start:prod
```

---

## 3. Suíte de Testes Automatizados
Todos os testes de integração, concorrência e carga são executados contra instâncias reais do PostgreSQL e do LocalStack (SQS) rodando nos containers Docker (sem mocks de banco ou de fila).

⚠️ Importante: Certifique-se de que os containers (docker compose up -d) e as migrations (bun run migration:run) estão ativos antes de rodar as suítes de integração, concorrência e carga.

```bash
# Rodar todas as suítes (Unidade + Integração + Concorrência)
bun test

# 1. Testes Unitários (Domínio puro: Money, Wallet, WagerTransaction, Ledger, PayloadHash)
bun run test:unit

# 2. Testes de Integração (Constraints SQL, Trigger de Imutabilidade, Fluxo Completo, SQS Inbox/Outbox/DLQ)
bun run test:integration

# 3. Testes de Concorrência e Crash Recovery (Os 8 cenários obrigatórios da Seção 13)
bun run test:concurrency

# 4. Diferencial Opcional: Teste de Carga (Throughput, p50/p95/p99, Hot Wallets, Replays, Outbox Lag e Reconciliação)
bun run test:load
```

---

## 4. Guia de Validação Manual (Exemplos Copy & Paste)
Com a aplicação rodando (bun run start:dev), defina a URL base no seu terminal (ajuste a porta caso tenha alterado no .env):

```bash
export API_URL="http://localhost:3000"
```

### 4.1. Health Checks e Métricas (Sem Autenticação)
```bash
curl -s "$API_URL/health/live" | jq
curl -s "$API_URL/health/ready" | jq
curl -s "$API_URL/metrics" | jq
```

### 4.2. Criar uma Carteira (`POST /wallets`)
Gera a carteira com saldo inicial de `1000.00 BRL` e cria atomicamente a transação interna `OPENING` + lançamento `CREDIT` no Ledger:
```bash
curl -s -X POST "$API_URL/wallets" \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }' | jq
```
(Copie o id retornado na resposta e exporte como export WALLET_ID="seu-wallet-id" para os próximos comandos).

### 4.3. Submeter uma Aposta (`POST /wagering/transactions`)
```bash
curl -s -X POST "$API_URL/wagering/transactions" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-1001" \
  -d "{
    \"providerId\": \"provider-a\",
    \"externalTransactionId\": \"tx-1001\",
    \"playerId\": \"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-987\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"BET\",
    \"money\": { \"amount\": \"25.00\", \"currency\": \"BRL\" }
  }" | jq
```
- Testar Replay Idempotente: Execute exatamente o mesmo comando acima novamente. A resposta trará `"idempotentReplay": true` e `"balance": { "amount": "975.00", "currency": "BRL" }` sem duplicar o débito.
- Testar Conflito de Idempotência (`409 Conflict`): Execute o comando acima mantendo o header `Idempotency-Key: provider-a:tx-1001`, mas alterando o `amount` para `"50.00"`.

### 4.4. Consultar Carteira, Ledger Paginado por Cursor e Transação
```bash
# Consultar saldo e versão da carteira
curl -s "$API_URL/wallets/$WALLET_ID" | jq

# Consultar extrato contábil (Ledger) com cursor estável e opaco
curl -s "$API_URL/wallets/$WALLET_ID/ledger?limit=10" | jq

# Consultar transação pelo ID externo do provedor
curl -s "$API_URL/providers/provider-a/wagering/transactions/tx-1001" | jq
```

### 4.5. Executar Reconciliação Contábil (`POST /wallets/:walletId/reconciliation`)
Verifica se `wallet.balance` é estritamente igual à soma algébrica de todos os lançamentos do Ledger:
```bash
curl -s -X POST "$API_URL/wallets/$WALLET_ID/reconciliation" | jq
```

### 4.6. Testar Processamento Assíncrono via Fila SQS (`wager-transactions.fifo`)
Envie uma mensagem diretamente para a fila SQS no LocalStack para vê-la ser consumida via Transactional Inbox:
```bash
docker exec wagering_localstack awslocal sqs send-message \
  --queue-url [http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo](http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo) \
  --message-group-id "$WALLET_ID" \
  --message-deduplication-id "dedup-sqs-2001" \
  --message-body "{
    \"messageId\": \"msg-sqs-2001\",
    \"type\": \"WagerTransactionRequested\",
    \"occurredAt\": \"2026-07-29T15:00:00.000Z\",
    \"data\": {
      \"providerId\": \"provider-a\",
      \"externalTransactionId\": \"tx-sqs-2001\",
      \"idempotencyKey\": \"provider-a:tx-sqs-2001\",
      \"playerId\": \"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",
      \"walletId\": \"$WALLET_ID\",
      \"roundId\": \"round-987\",
      \"gameId\": \"fortune-chimp\",
      \"kind\": \"WIN\",
      \"money\": { \"amount\": \"100.00\", \"currency\": \"BRL\" },
      \"referenceExternalTransactionId\": \"tx-1001\"
    }
  }"
```

---

5. Estrutura do Projeto
```Plaintext
src/
├── domain/                     # Núcleo rico e puro (Zero dependências de ORM/Framework)
│   ├── entities/               # Wallet (Aggregate Root), WagerTransaction, WalletLedgerEntry, Inbox, Outbox
│   ├── value-objects/          # Money (decimal.js imutável) e utilitário de payloadHash canônico (SHA-256)
│   ├── events/                 # IntegrationEvent e subclasses tipadas (Processed, Rejected, BalanceChanged, PendingRef)
│   └── errors/                 # Hierarquia de DomainError e enum FailureCode
├── application/                # Orquestração de casos de uso e contratos (Ports)
│   ├── ports/                  # Interfaces de repositório, UnitOfWorkPort e codificador de Cursor Opaco
│   └── use-cases/              # CreateWallet, ProcessWagerTransaction, ReconcileWallet e Queries
├── infrastructure/             # Adaptadores externos (Banco, Mensageria, Observabilidade)
│   ├── database/
│   │   ├── entities/           # Entidades de persistência do TypeORM (*.orm-entity.ts)
│   │   ├── mappers/            # Conversores explícitos Domínio <-> Persistência (usando .rehydrate())
│   │   ├── migrations/         # DDL SQL reversível com CHECKs, UNIQUEs parciais e Trigger de imutabilidade
│   │   └── repositories/       # Implementação do UnitOfWork e repositórios com SELECT ... FOR UPDATE
│   ├── messaging/
│   │   ├── sqs/                # Cliente SQS e WagerSqsConsumer (Inbox, ACK pós-commit, DLQ e SIGTERM)
│   │   └── outbox/             # OutboxPublisherWorker e PendingReferenceWorker (FOR UPDATE SKIP LOCKED)
│   └── observability/          # StructuredJsonLogger (com redação financeira) e MetricsService
└── presentation/
    └── http/                   # Controllers REST, DomainExceptionFilter semântico e AuthGuard (no-op extensível)
```
