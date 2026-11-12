import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform admin (D-062): `users.is_platform_admin` (default false), `organizations.suspended_at`
 * (null = active), `organizations.owner_id` may be empty while a new owner's invitation waits, and the
 * `organization_invitations` table (one waiting owner invitation per organization, the secret kept only
 * as its SHA-256). No existing row changes: every user is not a super admin, every organization is
 * active and keeps its owner. `down` fails if an organization is still waiting for its owner.
 */
export class AddPlatformAdmin1794470965710 implements MigrationInterface {
  name = 'AddPlatformAdmin1794470965710';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "organization_invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" uuid NOT NULL, "email" text NOT NULL, "name" text NOT NULL, "token_hash" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "invited_by" uuid, CONSTRAINT "organization_invitations_token_hash_key" UNIQUE ("token_hash"), CONSTRAINT "organization_invitations_organization_id_key" UNIQUE ("organization_id"), CONSTRAINT "organization_invitations_email_lowercase_check" CHECK ("email" = lower("email")), CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "organization_invitations_invited_by_idx" ON "organization_invitations"  ("invited_by") `,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_platform_admin" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "suspended_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "organizations_owner_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ALTER COLUMN "owner_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "organization_invitations_invited_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "organization_invitations_organization_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "organizations_owner_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ALTER COLUMN "owner_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN "suspended_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "is_platform_admin"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."organization_invitations_invited_by_idx"`,
    );
    await queryRunner.query(`DROP TABLE "organization_invitations"`);
  }
}
