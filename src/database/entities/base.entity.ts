import {
  BeforeInsert,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

/**
 * UUID primary key. The app assigns a v7 UUID (time-ordered, so new rows land at the end of
 * the index instead of at random positions the way v4 does). The database default
 * `gen_random_uuid()` is a fallback for rows inserted by hand-written SQL.
 *
 * Declared as a generated column because that is how TypeORM reads a `gen_random_uuid()` default
 * back from Postgres; a value set before insert is still the one written.
 */
export abstract class UuidEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @BeforeInsert()
  protected assignId(): void {
    this.id ??= uuidv7();
  }
}

/** For rows that are written once and never edited (revisions, form submissions). */
export abstract class ImmutableEntity extends UuidEntity {
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** For rows that change over time. `updatedAt` is maintained by TypeORM on save, not by SQL. */
export abstract class TimestampedEntity extends UuidEntity {
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
