import type { DataSource } from 'typeorm';

/**
 * Empties every table so each test starts from nothing and sets up only the data it needs.
 * Refuses to run against any database whose name does not end in `_test`.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const [{ name }] = await dataSource.query<{ name: string }[]>(
    'SELECT current_database() AS name',
  );
  if (!name.endsWith('_test')) {
    throw new Error(`resetDatabase refused: "${name}" is not a test database`);
  }
  const tables = dataSource.entityMetadatas
    .map((meta) => `"${meta.tableName}"`)
    .join(', ');
  await dataSource.query(`TRUNCATE ${tables} CASCADE`);
}
