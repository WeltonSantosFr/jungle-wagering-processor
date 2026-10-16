# Distributed Wagering Processor — Jungle Gaming Challenge 🦧

Processador financeiro distribuído de apostas (iGaming) construído com **Bun**, **NestJS**, **TypeScript (Strict Mode)**, **TypeORM**, **PostgreSQL** e **AWS SQS (LocalStack)**.

O projeto implementa garantias estritas de correção monetária, controle de concorrência pessimista por carteira (`SELECT ... FOR UPDATE`), idempotência persistente com verificação de hash canônico, **Transactional Inbox/Outbox**, resolução assíncrona de referências fora de ordem (`PENDING_REFERENCE`), ledger contábil imutável no banco de dados e observabilidade estruturada.

> As decisões arquiteturais detalhadas, justificativas de ORM, estratégia de locking, desenho de autenticação e trade-offs encontram-se em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## 1. Pré-requisitos

- **Bun** `>= 1.1`
- **Docker** e **Docker Compose**

---

## 2. Setup Rápido (Passo a Passo)

### 2.1 Instalar dependências e configurar variáveis de ambiente
```bash
bun install
cp .env.example .env