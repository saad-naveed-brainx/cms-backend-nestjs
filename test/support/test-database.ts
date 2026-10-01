/**
 * API tests run against their own database: the app's database name plus `_test`
 * (`cms` → `cms_test`, a slot's `cms_wt2` → `cms_wt2_test`). Tests wipe it freely, so it must
 * never be the database you develop against.
 */
export function testDatabaseUrl(appDatabaseUrl: string | undefined): string {
  if (!appDatabaseUrl) {
    throw new Error(
      'DATABASE_URL is not set: API tests derive their test database from it',
    );
  }
  const url = new URL(appDatabaseUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unexpected database name "${name}" in DATABASE_URL`);
  }
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}
