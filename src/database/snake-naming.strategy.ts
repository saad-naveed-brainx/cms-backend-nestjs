import {
  DefaultNamingStrategy,
  type Table,
  type NamingStrategyInterface,
} from 'typeorm';

/** Postgres truncates identifiers longer than this, which would silently merge names. */
const MAX_IDENTIFIER_LENGTH = 63;

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Maps camelCase entity properties to snake_case columns (`siteId` → `site_id`) and gives
 * constraints Postgres-style readable names (`content_site_id_path_key`) instead of TypeORM's
 * hashed defaults, so a constraint violation names the rule it broke.
 *
 * A readable name that would exceed Postgres's 63-character limit falls back to the hashed
 * default rather than being truncated.
 */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override columnName(
    propertyName: string,
    customName: string | undefined,
    prefixes: string[],
  ): string {
    return customName ?? snakeCase([...prefixes, propertyName].join('_'));
  }

  override joinColumnName(
    relationName: string,
    referencedColumnName: string,
  ): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string,
  ): string {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }

  override primaryKeyName(
    table: Table | string,
    columnNames: string[],
  ): string {
    return this.readable(`${this.getTableName(table)}_pkey`, () =>
      super.primaryKeyName(table, columnNames),
    );
  }

  override uniqueConstraintName(
    table: Table | string,
    columnNames: string[],
  ): string {
    return this.readable(this.joined(table, columnNames, 'key'), () =>
      super.uniqueConstraintName(table, columnNames),
    );
  }

  override indexName(
    table: Table | string,
    columnNames: string[],
    where?: string,
  ): string {
    return this.readable(this.joined(table, columnNames, 'idx'), () =>
      super.indexName(table, columnNames, where),
    );
  }

  override foreignKeyName(
    table: Table | string,
    columnNames: string[],
    referencedTablePath?: string,
    referencedColumnNames?: string[],
  ): string {
    return this.readable(this.joined(table, columnNames, 'fkey'), () =>
      super.foreignKeyName(
        table,
        columnNames,
        referencedTablePath,
        referencedColumnNames,
      ),
    );
  }

  private joined(
    table: Table | string,
    columnNames: string[],
    suffix: string,
  ): string {
    return `${this.getTableName(table)}_${columnNames.join('_')}_${suffix}`;
  }

  private readable(name: string, fallback: () => string): string {
    return name.length <= MAX_IDENTIFIER_LENGTH ? name : fallback();
  }
}
