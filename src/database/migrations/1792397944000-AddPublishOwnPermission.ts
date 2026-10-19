import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `content.publish_own` to the `permission` enum (users-roles plan D2), next to
 * `content.publish` so the type's order matches `Permission` in code.
 *
 * Postgres cannot use a new enum value in the transaction that added it, so this runs in its own
 * transaction, before `AddFiveRoles` uses the value (`migrationsTransactionMode: 'each'`).
 */
export class AddPublishOwnPermission1792397944000 implements MigrationInterface {
  name = 'AddPublishOwnPermission1792397944000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."permission" ADD VALUE IF NOT EXISTS 'content.publish_own' AFTER 'content.publish'`,
    );
  }

  /**
   * Leaves the value in place: Postgres cannot drop an enum value without rebuilding the type and
   * every column using it. Unused, it is harmless; `AddFiveRoles`' down removes it from roles.
   */
  public async down(): Promise<void> {}
}
