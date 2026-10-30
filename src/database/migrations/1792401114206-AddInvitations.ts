import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `invitations` table (users-roles plan D3, D-047): one waiting invite per email per site, the
 * link's secret kept only as its SHA-256. Deleting a site deletes its invitations (cascade); the
 * role is a composite `(site_id, role_id)` key with no cascade; the inviter becomes `null` when
 * their account is deleted. A new, empty table: no existing row changes.
 */
export class AddInvitations1792401114206 implements MigrationInterface {
  name = 'AddInvitations1792401114206';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "email" text NOT NULL, "role_id" uuid NOT NULL, "token_hash" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "invited_by" uuid, CONSTRAINT "invitations_token_hash_key" UNIQUE ("token_hash"), CONSTRAINT "invitations_site_id_email_key" UNIQUE ("site_id", "email"), CONSTRAINT "invitations_email_lowercase_check" CHECK ("email" = lower("email")), CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_invited_by_idx" ON "invitations"  ("invited_by") `,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_site_id_role_id_idx" ON "invitations"  ("site_id", "role_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "invitations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "invitations_site_id_role_id_fkey" FOREIGN KEY ("site_id", "role_id") REFERENCES "roles"("site_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "invitations_site_id_role_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "invitations_site_id_fkey"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."invitations_site_id_role_id_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."invitations_invited_by_idx"`);
    await queryRunner.query(`DROP TABLE "invitations"`);
  }
}
