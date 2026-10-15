#!/bin/bash
set -e

echo "Criando filas SQS FIFO..."

# 1. Cria a DLQ
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# 2. Cria a fila principal apontando para a DLQ após 3 tentativas
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }"

# 3. Cria a fila de eventos para o Transactional Outbox publicar
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "Filas SQS criadas com sucesso!"