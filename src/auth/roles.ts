import { Permission } from './permission.js';

/** The role every site's creator holds. */
export const ADMINISTRATOR_ROLE = 'Administrator';

/** The five fixed roles every site has (users-roles plan D1). */
export type RoleName =
  | 'Administrator'
  | 'Editor'
  | 'Author'
  | 'Contributor'
  | 'Viewer';

/**
 * The roles a new site is given, in this order, each with its permissions. Roles are stored per
 * site (D-013), so this list is what a NEW site starts with: a change here reaches existing sites
 * only through a migration, which copies the lists as literals (a migration is a snapshot).
 *
 * Viewer has no permission: any member may read and preview a site's pages.
 */
export const ROLE_DEFINITIONS: readonly {
  name: RoleName;
  permissions: readonly Permission[];
}[] = [
  { name: ADMINISTRATOR_ROLE, permissions: Object.values(Permission) },
  {
    name: 'Editor',
    permissions: [
      Permission.ContentCreate,
      Permission.ContentEditOwn,
      Permission.ContentEditAny,
      Permission.ContentPublish,
      Permission.ContentDelete,
      Permission.MediaUpload,
      Permission.MediaDelete,
      Permission.TermsManage,
      Permission.MenusManage,
      Permission.RedirectsManage,
      Permission.FormsView,
    ],
  },
  {
    name: 'Author',
    permissions: [
      Permission.ContentCreate,
      Permission.ContentEditOwn,
      Permission.ContentPublishOwn,
      Permission.MediaUpload,
    ],
  },
  {
    name: 'Contributor',
    permissions: [Permission.ContentCreate, Permission.ContentEditOwn],
  },
  { name: 'Viewer', permissions: [] },
];
