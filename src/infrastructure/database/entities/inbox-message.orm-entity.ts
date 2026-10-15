import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('inbox_messages')
export class InboxMessageOrmEntity {
  @PrimaryColumn({ name: 'consumer_name', type: 'varchar', length: 100 })
  consumerName: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 150 })
  messageId: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}