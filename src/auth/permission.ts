/**
 * Every permission a role can grant. Code-defined on purpose: a permission only does something
 * when a guard checks it, so the list changes with a deploy, never at runtime. Roles are the
 * runtime part: each role row holds a subset of these (DECISIONS.md D-013).
 *
 * Stored as the Postgres enum `permission`. Adding a value is a simple migration; removing one
 * means rebuilding the type, so add only what a real check needs.
 */
export enum Permission {
  ContentCreate = 'content.create',
  ContentEditOwn = 'content.edit_own',
  ContentEditAny = 'content.edit_any',
  ContentPublish = 'content.publish',
  ContentDelete = 'content.delete',
  ContentTypesManage = 'content_types.manage',
  MediaUpload = 'media.upload',
  MediaDelete = 'media.delete',
  TermsManage = 'terms.manage',
  MenusManage = 'menus.manage',
  RedirectsManage = 'redirects.manage',
  FormsView = 'forms.view',
  MembersManage = 'members.manage',
  SettingsManage = 'settings.manage',
}
