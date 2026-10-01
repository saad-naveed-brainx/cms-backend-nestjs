import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1790837168503 implements MigrationInterface {
  name = 'InitialSchema1790837168503';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" text NOT NULL, "password_hash" text NOT NULL, "name" text NOT NULL, CONSTRAINT "users_email_key" UNIQUE ("email"), CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email")), CONSTRAINT "users_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "organizations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" text NOT NULL, "owner_id" uuid NOT NULL, CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "organizations_owner_id_idx" ON "organizations"  ("owner_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "sites" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" uuid NOT NULL, "name" text NOT NULL, "theme" jsonb NOT NULL DEFAULT '{}', "settings" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "sites_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "sites_organization_id_idx" ON "sites"  ("organization_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "content_types" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "name" text NOT NULL, "slug" text NOT NULL, "url_prefix" text, "fields" jsonb NOT NULL DEFAULT '[]', "hierarchical" boolean NOT NULL DEFAULT false, "is_builtin" boolean NOT NULL DEFAULT false, "has_categories" boolean NOT NULL DEFAULT false, "has_tags" boolean NOT NULL DEFAULT false, CONSTRAINT "content_types_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "content_types_site_id_url_prefix_key" UNIQUE ("site_id", "url_prefix"), CONSTRAINT "content_types_site_id_slug_key" UNIQUE ("site_id", "slug"), CONSTRAINT "content_types_url_prefix_format_check" CHECK ("url_prefix" IS NULL OR "url_prefix" ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$'), CONSTRAINT "content_types_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'), CONSTRAINT "content_types_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "media" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "filename" text NOT NULL, "storage_key" text NOT NULL, "mime_type" text NOT NULL, "size_bytes" integer NOT NULL, "width" integer, "height" integer, "variants" jsonb NOT NULL DEFAULT '{}', "alt_text" text, "title" text, "description" text, "uploaded_by" uuid, CONSTRAINT "media_storage_key_key" UNIQUE ("storage_key"), CONSTRAINT "media_size_bytes_check" CHECK ("size_bytes" >= 0), CONSTRAINT "media_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "media_uploaded_by_idx" ON "media"  ("uploaded_by") `,
    );
    await queryRunner.query(
      `CREATE INDEX "media_site_id_created_at_idx" ON "media"  ("site_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."content_status" AS ENUM('draft', 'pending_review', 'published', 'scheduled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "content" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "content_type_id" uuid NOT NULL, "parent_id" uuid, "title" text NOT NULL, "slug" text NOT NULL, "path" text NOT NULL, "status" "public"."content_status" NOT NULL DEFAULT 'draft', "blocks" jsonb NOT NULL DEFAULT '[]', "data" jsonb NOT NULL DEFAULT '{}', "seo_title" text, "seo_description" text, "canonical_url" text, "og_image_id" uuid, "no_index" boolean NOT NULL DEFAULT false, "published_at" TIMESTAMP WITH TIME ZONE, "scheduled_at" TIMESTAMP WITH TIME ZONE, "deleted_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid, "updated_by" uuid, CONSTRAINT "content_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "content_site_id_path_key" UNIQUE ("site_id", "path"), CONSTRAINT "content_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"), CONSTRAINT "content_scheduled_has_time_check" CHECK ("status" <> 'scheduled' OR "scheduled_at" IS NOT NULL), CONSTRAINT "content_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "content_updated_by_idx" ON "content"  ("updated_by") `,
    );
    await queryRunner.query(
      `CREATE INDEX "content_created_by_idx" ON "content"  ("created_by") `,
    );
    await queryRunner.query(
      `CREATE INDEX "content_og_image_id_idx" ON "content"  ("og_image_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "content_site_id_parent_id_idx" ON "content"  ("site_id", "parent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "content_site_id_content_type_id_status_idx" ON "content"  ("site_id", "content_type_id", "status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "form_submissions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "content_id" uuid, "data" jsonb NOT NULL, CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "form_submissions_content_id_idx" ON "form_submissions"  ("content_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "form_submissions_site_id_created_at_idx" ON "form_submissions"  ("site_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "hostnames" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "hostname" text NOT NULL, "is_primary" boolean NOT NULL DEFAULT false, CONSTRAINT "hostnames_hostname_key" UNIQUE ("hostname"), CONSTRAINT "hostnames_hostname_lowercase_check" CHECK ("hostname" = lower("hostname")), CONSTRAINT "hostnames_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "hostnames_one_primary_per_site_idx" ON "hostnames"  ("site_id") WHERE "is_primary"`,
    );
    await queryRunner.query(
      `CREATE INDEX "hostnames_site_id_idx" ON "hostnames"  ("site_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."menu_location" AS ENUM('header', 'footer')`,
    );
    await queryRunner.query(
      `CREATE TABLE "menus" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "name" text NOT NULL, "location" "public"."menu_location" NOT NULL, CONSTRAINT "menus_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "menus_site_id_location_key" UNIQUE ("site_id", "location"), CONSTRAINT "menus_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "menu_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "menu_id" uuid NOT NULL, "parent_id" uuid, "position" integer NOT NULL DEFAULT '0', "label" text NOT NULL, "content_id" uuid, "url" text, "open_in_new_tab" boolean NOT NULL DEFAULT false, CONSTRAINT "menu_items_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "menu_items_single_target_check" CHECK ("content_id" IS NULL OR "url" IS NULL), CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "menu_items_content_id_idx" ON "menu_items"  ("content_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "menu_items_site_id_parent_id_idx" ON "menu_items"  ("site_id", "parent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "menu_items_site_id_menu_id_position_idx" ON "menu_items"  ("site_id", "menu_id", "position") `,
    );
    await queryRunner.query(
      `CREATE TABLE "redirects" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "from_path" text NOT NULL, "to_path" text NOT NULL, "status_code" smallint NOT NULL DEFAULT '301', "is_automatic" boolean NOT NULL DEFAULT false, CONSTRAINT "redirects_site_id_from_path_key" UNIQUE ("site_id", "from_path"), CONSTRAINT "redirects_not_to_self_check" CHECK ("from_path" <> "to_path"), CONSTRAINT "redirects_status_code_check" CHECK ("status_code" IN (301, 302, 307, 308)), CONSTRAINT "redirects_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "revisions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "content_id" uuid NOT NULL, "snapshot" jsonb NOT NULL, "created_by" uuid, CONSTRAINT "revisions_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "revisions_created_by_idx" ON "revisions"  ("created_by") `,
    );
    await queryRunner.query(
      `CREATE INDEX "revisions_site_id_content_id_created_at_idx" ON "revisions"  ("site_id", "content_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."permission" AS ENUM('content.create', 'content.edit_own', 'content.edit_any', 'content.publish', 'content.delete', 'content_types.manage', 'media.upload', 'media.delete', 'terms.manage', 'menus.manage', 'redirects.manage', 'forms.view', 'members.manage', 'settings.manage')`,
    );
    await queryRunner.query(
      `CREATE TABLE "roles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "name" text NOT NULL, "permissions" "public"."permission" array NOT NULL DEFAULT '{}', CONSTRAINT "roles_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "roles_site_id_name_key" UNIQUE ("site_id", "name"), CONSTRAINT "roles_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "site_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role_id" uuid NOT NULL, CONSTRAINT "site_members_site_id_user_id_key" UNIQUE ("site_id", "user_id"), CONSTRAINT "site_members_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "site_members_user_id_idx" ON "site_members"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "site_members_site_id_role_id_idx" ON "site_members"  ("site_id", "role_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."term_taxonomy" AS ENUM('category', 'tag')`,
    );
    await queryRunner.query(
      `CREATE TABLE "terms" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "site_id" uuid NOT NULL, "taxonomy" "public"."term_taxonomy" NOT NULL, "name" text NOT NULL, "slug" text NOT NULL, "no_index" boolean NOT NULL DEFAULT true, CONSTRAINT "terms_site_id_id_key" UNIQUE ("site_id", "id"), CONSTRAINT "terms_site_id_taxonomy_slug_key" UNIQUE ("site_id", "taxonomy", "slug"), CONSTRAINT "terms_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "term_content" ("site_id" uuid NOT NULL, "content_id" uuid NOT NULL, "term_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "term_content_pkey" PRIMARY KEY ("site_id", "content_id", "term_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "term_content_site_id_term_id_idx" ON "term_content"  ("site_id", "term_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content_types" ADD CONSTRAINT "content_types_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD CONSTRAINT "media_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_og_image_id_fkey" FOREIGN KEY ("og_image_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_site_id_parent_id_fkey" FOREIGN KEY ("site_id", "parent_id") REFERENCES "content"("site_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" ADD CONSTRAINT "content_site_id_content_type_id_fkey" FOREIGN KEY ("site_id", "content_type_id") REFERENCES "content_types"("site_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "hostnames" ADD CONSTRAINT "hostnames_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "menus" ADD CONSTRAINT "menus_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_site_id_parent_id_fkey" FOREIGN KEY ("site_id", "parent_id") REFERENCES "menu_items"("site_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_site_id_menu_id_fkey" FOREIGN KEY ("site_id", "menu_id") REFERENCES "menus"("site_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "redirects" ADD CONSTRAINT "redirects_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD CONSTRAINT "revisions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD CONSTRAINT "revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD CONSTRAINT "revisions_site_id_content_id_fkey" FOREIGN KEY ("site_id", "content_id") REFERENCES "content"("site_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD CONSTRAINT "roles_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" ADD CONSTRAINT "site_members_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" ADD CONSTRAINT "site_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" ADD CONSTRAINT "site_members_site_id_role_id_fkey" FOREIGN KEY ("site_id", "role_id") REFERENCES "roles"("site_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "terms" ADD CONSTRAINT "terms_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "term_content" ADD CONSTRAINT "term_content_site_id_term_id_fkey" FOREIGN KEY ("site_id", "term_id") REFERENCES "terms"("site_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "term_content" ADD CONSTRAINT "term_content_site_id_content_id_fkey" FOREIGN KEY ("site_id", "content_id") REFERENCES "content"("site_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "term_content" DROP CONSTRAINT "term_content_site_id_content_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "term_content" DROP CONSTRAINT "term_content_site_id_term_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "terms" DROP CONSTRAINT "terms_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" DROP CONSTRAINT "site_members_site_id_role_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" DROP CONSTRAINT "site_members_user_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "site_members" DROP CONSTRAINT "site_members_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "roles_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" DROP CONSTRAINT "revisions_site_id_content_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" DROP CONSTRAINT "revisions_created_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" DROP CONSTRAINT "revisions_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "redirects" DROP CONSTRAINT "redirects_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_site_id_menu_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_site_id_parent_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_content_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "menus" DROP CONSTRAINT "menus_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "hostnames" DROP CONSTRAINT "hostnames_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "form_submissions" DROP CONSTRAINT "form_submissions_content_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "form_submissions" DROP CONSTRAINT "form_submissions_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_site_id_content_type_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_site_id_parent_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_updated_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_created_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_og_image_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content" DROP CONSTRAINT "content_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP CONSTRAINT "media_uploaded_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP CONSTRAINT "media_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "content_types" DROP CONSTRAINT "content_types_site_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP CONSTRAINT "sites_organization_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "organizations_owner_id_fkey"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."term_content_site_id_term_id_idx"`,
    );
    await queryRunner.query(`DROP TABLE "term_content"`);
    await queryRunner.query(`DROP TABLE "terms"`);
    await queryRunner.query(`DROP TYPE "public"."term_taxonomy"`);
    await queryRunner.query(
      `DROP INDEX "public"."site_members_site_id_role_id_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."site_members_user_id_idx"`);
    await queryRunner.query(`DROP TABLE "site_members"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    await queryRunner.query(`DROP TYPE "public"."permission"`);
    await queryRunner.query(
      `DROP INDEX "public"."revisions_site_id_content_id_created_at_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."revisions_created_by_idx"`);
    await queryRunner.query(`DROP TABLE "revisions"`);
    await queryRunner.query(`DROP TABLE "redirects"`);
    await queryRunner.query(
      `DROP INDEX "public"."menu_items_site_id_menu_id_position_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."menu_items_site_id_parent_id_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."menu_items_content_id_idx"`);
    await queryRunner.query(`DROP TABLE "menu_items"`);
    await queryRunner.query(`DROP TABLE "menus"`);
    await queryRunner.query(`DROP TYPE "public"."menu_location"`);
    await queryRunner.query(`DROP INDEX "public"."hostnames_site_id_idx"`);
    await queryRunner.query(
      `DROP INDEX "public"."hostnames_one_primary_per_site_idx"`,
    );
    await queryRunner.query(`DROP TABLE "hostnames"`);
    await queryRunner.query(
      `DROP INDEX "public"."form_submissions_site_id_created_at_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."form_submissions_content_id_idx"`,
    );
    await queryRunner.query(`DROP TABLE "form_submissions"`);
    await queryRunner.query(
      `DROP INDEX "public"."content_site_id_content_type_id_status_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."content_site_id_parent_id_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."content_og_image_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."content_created_by_idx"`);
    await queryRunner.query(`DROP INDEX "public"."content_updated_by_idx"`);
    await queryRunner.query(`DROP TABLE "content"`);
    await queryRunner.query(`DROP TYPE "public"."content_status"`);
    await queryRunner.query(
      `DROP INDEX "public"."media_site_id_created_at_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."media_uploaded_by_idx"`);
    await queryRunner.query(`DROP TABLE "media"`);
    await queryRunner.query(`DROP TABLE "content_types"`);
    await queryRunner.query(`DROP INDEX "public"."sites_organization_id_idx"`);
    await queryRunner.query(`DROP TABLE "sites"`);
    await queryRunner.query(`DROP INDEX "public"."organizations_owner_id_idx"`);
    await queryRunner.query(`DROP TABLE "organizations"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
