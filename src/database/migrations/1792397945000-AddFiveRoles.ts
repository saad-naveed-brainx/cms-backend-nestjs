import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every existing site gets the four roles it lacks (users-roles plan D1), and every role holding
 * `members.manage` (the Administrators) gets `content.publish_own`, so their list stays complete.
 *
 * The permission lists are literals on purpose: a migration is a snapshot of what the roles were
 * when it ran, and must not change when `src/auth/roles.ts` does. Safe to run twice: a site that
 * already has a role of that name keeps it untouched, and no permission is added twice.
 */
const NEW_ROLES: { name: string; permissions: string[] }[] = [
  {
    name: 'Editor',
    permissions: [
      'content.create',
      'content.edit_own',
      'content.edit_any',
      'content.publish',
      'content.delete',
      'media.upload',
      'media.delete',
      'terms.manage',
      'menus.manage',
      'redirects.manage',
      'forms.view',
    ],
  },
  {
    name: 'Author',
    permissions: [
      'content.create',
      'content.edit_own',
      'content.publish_own',
      'media.upload',
    ],
  },
  { name: 'Contributor', permissions: ['content.create', 'content.edit_own'] },
  { name: 'Viewer', permissions: [] },
];

export class AddFiveRoles1792397945000 implements MigrationInterface {
  name = 'AddFiveRoles1792397945000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const role of NEW_ROLES) {
      await queryRunner.query(
        `INSERT INTO "roles" ("site_id", "name", "permissions")
         SELECT s."id", $1, $2::text[]::"public"."permission"[]
           FROM "sites" s
          WHERE NOT EXISTS (
            SELECT 1 FROM "roles" r WHERE r."site_id" = s."id" AND r."name" = $1
          )`,
        [role.name, role.permissions],
      );
    }
    await queryRunner.query(
      `UPDATE "roles"
          SET "permissions" = array_append("permissions", 'content.publish_own')
        WHERE 'members.manage' = ANY("permissions")
          AND NOT ('content.publish_own' = ANY("permissions"))`,
    );
  }

  /** Removes the four roles where nobody holds them, and `content.publish_own` from Administrators. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "roles" r
        WHERE r."name" = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM "site_members" m WHERE m."role_id" = r."id")`,
      [NEW_ROLES.map((role) => role.name)],
    );
    await queryRunner.query(
      `UPDATE "roles"
          SET "permissions" = array_remove("permissions", 'content.publish_own')
        WHERE "name" = 'Administrator'`,
    );
  }
}
