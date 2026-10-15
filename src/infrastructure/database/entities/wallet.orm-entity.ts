import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('wallets')
export class WalletOrmEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  balance: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}