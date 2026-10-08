import type { DataSource } from 'typeorm';

/**
 * Helpers for the tenant seed tests (FND-06): a valid input to bend one field of, row counts for
 * "nothing was created", a dump of every stored value for "the password is nowhere in the
 * database", and the fake output the command writes to. Every name, address and password in the
 * tests lives in the tests: nothing here is something the app could borrow.
 */

export type TenantInputShape = {
  organizationName: string;
  siteName: string;
  hostnames: string[];
  admin: { email: string; name: string; password?: string };
};

type TenantOverrides = Partial<Omit<TenantInputShape, 'admin'>> & {
  admin?: Partial<TenantInputShape['admin']>;
};

/**
 * A valid tenant input with no password (so the admin gets a generated one, unless the test gives
 * one). Whatever `overrides` names replaces the default; `admin` is merged field by field.
 */
export function tenantInput(overrides: TenantOverrides = {}): TenantInputShape {
  const { admin, ...rest } = overrides;
  return {
    organizationName: 'Orchard Holdings',
    siteName: 'Orchard Bakery',
    hostnames: ['orchard.test'],
    ...rest,
    admin: { email: 'olivia@orchard.test', name: 'Olivia Orchard', ...admin },
  };
}

const tableNames = (dataSource: DataSource): string[] =>
  dataSource.entityMetadatas.map((meta) => meta.tableName).sort();

/** How many rows every table of the database holds, in one query. */
export async function rowCounts(
  dataSource: DataSource,
): Promise<Record<string, number>> {
  const selects = tableNames(dataSource).map(
    (table) =>
      `SELECT '${table}' AS "table", count(*)::int AS "rows" FROM "${table}"`,
  );
  const found = await dataSource.query<{ table: string; rows: number }[]>(
    selects.join(' UNION ALL '),
  );
  return Object.fromEntries(found.map(({ table, rows }) => [table, rows]));
}

/** What `rowCounts` says of a database with nothing in it: every table at zero. */
export function noRows(dataSource: DataSource): Record<string, number> {
  return Object.fromEntries(tableNames(dataSource).map((table) => [table, 0]));
}

/** Every row of every table as one piece of text, for "this value is not stored anywhere". */
export async function everythingStored(
  dataSource: DataSource,
): Promise<string> {
  const dumps: string[] = [];
  for (const table of tableNames(dataSource)) {
    dumps.push(
      JSON.stringify(await dataSource.query(`SELECT * FROM "${table}"`)),
    );
  }
  return dumps.join('\n');
}

/** The two streams of the command, as the tests see them: every line written, in order. */
export function recordingIo(): {
  io: { out: (line: string) => void; err: (line: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
    },
    out,
    err,
  };
}
