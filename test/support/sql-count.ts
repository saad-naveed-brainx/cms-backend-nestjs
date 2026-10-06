import type { DataSource } from 'typeorm';

/**
 * Runs `run` and returns what it gave back and every SQL statement sent meanwhile, counted with a
 * pass-through spy on TypeORM's query logger. Wrap only the calls under test: anything a test does
 * to set up or check afterwards belongs outside, or its statements are counted too.
 */
export async function withSqlCount<T>(
  dataSource: DataSource,
  run: () => Promise<T>,
): Promise<{ result: T; sql: string[] }> {
  const logQuery = vi.spyOn(dataSource.logger, 'logQuery');
  try {
    const result = await run();
    return { result, sql: logQuery.mock.calls.map(([sql]) => sql) };
  } finally {
    logQuery.mockRestore();
  }
}
