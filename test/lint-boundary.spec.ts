import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The lint boundary for invariant 1 (api/CLAUDE.md rule 2): only `*.repository.ts` files and a few
 * named infrastructure files may import TypeORM's raw database handles.
 *
 * Each case builds a throwaway project in the OS temp folder, laid out like this repo (`src/...`,
 * `test/...`), with a copy of the repo's real lint config. It then runs this repo's oxlint the way
 * `npm run lint` does: `oxlint src/ test/` with no `-c`, so the config is found by auto-discovery,
 * exactly as in CI. Nothing is written inside the repo, so `npm run lint` on the repo stays clean.
 *
 * `--format=json` only fixes the reporter. oxlint picks a different default reporter depending on
 * where it runs (a terminal, CI, an AI agent), so its default output is not stable to assert on.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const oxlintBin = join(repoRoot, 'node_modules', '.bin', 'oxlint');
const configName = '.oxlintrc.json';
const rule = 'no-restricted-imports';

type Diagnostic = {
  code: string;
  severity: string;
  message: string;
  help?: string;
  filename: string;
  labels: { span: { line: number; column: number } }[];
};

type LintRun = { status: number | null; diagnostics: Diagnostic[] };

const probeDirs: string[] = [];

afterEach(() => {
  for (const dir of probeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Joins source lines, so the line number of each import can be read off the test. */
function ts(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function oxlint(cwd: string, args: string[]) {
  const run = spawnSync(process.execPath, [oxlintBin, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (run.error) throw run.error;
  return run;
}

function parseJson<T>(run: ReturnType<typeof oxlint>, what: string): T {
  try {
    return JSON.parse(run.stdout) as T;
  } catch {
    throw new Error(
      `oxlint did not print ${what} as JSON (exit ${run.status})\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }
}

/** Runs `oxlint src/ test/` in `cwd`, with whatever config oxlint auto-discovers there. */
function lint(cwd: string): LintRun {
  const run = oxlint(cwd, ['--format=json', 'src/', 'test/']);
  const report = parseJson<{ diagnostics: Diagnostic[] }>(run, 'a lint report');
  return { status: run.status, diagnostics: report.diagnostics };
}

/** Path of the repo's real lint config. Fails clearly if it has a name oxlint would not find. */
function realConfig(): string {
  const path = join(repoRoot, configName);
  expect(
    existsSync(path),
    `the lint config must be named ${configName}: oxlint only auto-discovers that name, so \`npm run lint\` (no -c flag) silently ignores any other file, such as oxlint.json`,
  ).toBe(true);
  return path;
}

/** Lints `files` (path → source) in a throwaway project that uses the repo's real lint config. */
function lintProbe(files: Record<string, string>): LintRun {
  const config = realConfig();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lint-boundary-')));
  probeDirs.push(dir);
  copyFileSync(config, join(dir, configName));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  return lint(dir);
}

function isRestrictedImport(diagnostic: Diagnostic): boolean {
  return diagnostic.code.endsWith(`(${rule})`);
}

/** The restricted-import problems reported against one file. */
function restrictedImports(run: LintRun, file: string): Diagnostic[] {
  return run.diagnostics.filter(
    (d) => d.filename === file && isRestrictedImport(d),
  );
}

/** The lines of `file` the restricted-import rule flagged, in order. */
function flaggedLines(run: LintRun, file: string): number[] {
  return restrictedImports(run, file)
    .map((d) => d.labels[0]?.span.line)
    .sort((a, b) => a - b);
}

function summary(run: LintRun): string {
  const problems = run.diagnostics.map(
    (d) =>
      `  ${d.filename}:${d.labels[0]?.span.line} ${d.severity} ${d.code}: ${d.message}`,
  );
  return `lint exited ${run.status} and reported:\n${problems.join('\n') || '  (no problems)'}`;
}

/** Lint must exit with a failure and flag exactly these lines of `file` with the rule. */
function expectFlagged(run: LintRun, file: string, lines: number[]): void {
  expect(
    run.status,
    `lint must fail because of ${file}; ${summary(run)}`,
  ).not.toBe(0);
  expect(
    flaggedLines(run, file),
    `restricted-import lines in ${file}; ${summary(run)}`,
  ).toEqual(lines);
}

/** None of `files` is flagged by the rule, and lint exits cleanly. */
function expectPasses(run: LintRun, files: string[]): void {
  for (const file of files) {
    expect(
      flaggedLines(run, file),
      `${file} must not be flagged; ${summary(run)}`,
    ).toEqual([]);
  }
  expect(run.status, `lint must pass; ${summary(run)}`).toBe(0);
}

const ordersService = ts(
  "import { Injectable } from '@nestjs/common';",
  "import { Repository } from 'typeorm';",
  '',
  '@Injectable()',
  'export class OrdersService {',
  '  constructor(private readonly orders: Repository<object>) {}',
  '',
  '  count(): Promise<number> {',
  '    return this.orders.count();',
  '  }',
  '}',
);

describe('lint boundary: only repositories may import the raw TypeORM handles', () => {
  it('[UC-SR-42] a service importing Repository from typeorm fails the lint, on that file and line', () => {
    const run = lintProbe({ 'src/orders/orders.service.ts': ordersService });

    expectFlagged(run, 'src/orders/orders.service.ts', [2]);
  });

  const rawHandleImports = [
    {
      form: 'a named DataSource import',
      file: 'src/reports/reports.service.ts',
      source: ts(
        "import { DataSource } from 'typeorm';",
        '',
        'export const runReport = (db: DataSource) => db.query("SELECT 1");',
      ),
    },
    {
      form: 'a named EntityManager import',
      file: 'src/orders/orders.controller.ts',
      source: ts(
        "import { EntityManager } from 'typeorm';",
        '',
        'export const countOrders = (em: EntityManager) => em.query("SELECT 1");',
      ),
    },
    {
      form: 'a named Repository import',
      file: 'src/orders/orders.module.ts',
      source: ts(
        "import { Repository } from 'typeorm';",
        '',
        'export const countAll = (repo: Repository<object>) => repo.count();',
      ),
    },
    {
      form: 'an aliased { DataSource as DS } import',
      file: 'src/orders/order-export.ts',
      source: ts(
        "import { DataSource as DS } from 'typeorm';",
        '',
        'export const isReady = (db: DS) => db.isInitialized;',
      ),
    },
    {
      form: 'a type-only `import type { EntityManager }`',
      file: 'src/orders/orders.service.ts',
      source: ts(
        "import type { EntityManager } from 'typeorm';",
        '',
        'export const inTransaction = (em: EntityManager) => em.query("SELECT 1");',
      ),
    },
    {
      form: 'an inline `import { type EntityManager }`',
      file: 'src/orders/orders.service.ts',
      source: ts(
        "import { type EntityManager } from 'typeorm';",
        '',
        'export const inTransaction = (em: EntityManager) => em.query("SELECT 1");',
      ),
    },
    {
      form: 'DataSource hidden among allowed names, { Column, DataSource }',
      file: 'src/orders/orders.service.ts',
      source: ts(
        "import { Column, DataSource } from 'typeorm';",
        '',
        'export const parts = [Column, DataSource];',
      ),
    },
  ];

  for (const { form, file, source } of rawHandleImports) {
    it(`[UC-SR-43] ${form} from typeorm fails the lint outside a repository`, () => {
      const run = lintProbe({ [file]: source });

      expectFlagged(run, file, [1]);
    });
  }

  it('[UC-SR-44] a namespace import of typeorm fails the lint outside a repository', () => {
    const file = 'src/orders/orders.service.ts';
    const run = lintProbe({
      [file]: ts(
        "import * as typeorm from 'typeorm';",
        '',
        'export const isConnection = (value: unknown) => value instanceof typeorm.DataSource;',
      ),
    });

    expectFlagged(run, file, [1]);
  });

  const nestTypeormImports = [
    {
      name: 'InjectRepository',
      file: 'src/orders/orders.service.ts',
      source: ts(
        "import { Injectable } from '@nestjs/common';",
        "import { InjectRepository } from '@nestjs/typeorm';",
        '',
        '@Injectable()',
        'export class OrdersService {',
        '  constructor(@InjectRepository(Object) readonly orders: unknown) {}',
        '}',
      ),
    },
    {
      name: 'TypeOrmModule',
      file: 'src/orders/orders.module.ts',
      source: ts(
        "import { Module } from '@nestjs/common';",
        "import { TypeOrmModule } from '@nestjs/typeorm';",
        '',
        '@Module({ imports: [TypeOrmModule.forFeature([])] })',
        'export class OrdersModule {}',
      ),
    },
    {
      // Hands out a raw DataSource without importing it from typeorm: why the whole module is banned.
      name: 'InjectDataSource',
      file: 'src/reports/reports.service.ts',
      source: ts(
        "import { Injectable } from '@nestjs/common';",
        "import { InjectDataSource } from '@nestjs/typeorm';",
        '',
        '@Injectable()',
        'export class ReportsService {',
        '  constructor(@InjectDataSource() readonly db: unknown) {}',
        '}',
      ),
    },
  ];

  for (const { name, file, source } of nestTypeormImports) {
    it(`[UC-SR-45] importing ${name} from @nestjs/typeorm fails the lint outside the allowed files`, () => {
      const run = lintProbe({ [file]: source });

      expectFlagged(run, file, [2]);
    });
  }

  it('[UC-SR-46] a repository file may import DataSource, EntityManager and Repository', () => {
    const file = 'src/orders/orders.repository.ts';
    const run = lintProbe({
      [file]: ts(
        "import { Injectable } from '@nestjs/common';",
        "import { DataSource, EntityManager, Repository } from 'typeorm';",
        '',
        '@Injectable()',
        'export class OrdersRepository {',
        '  constructor(private readonly dataSource: DataSource) {}',
        '',
        '  private orders(): Repository<object> {',
        "    return this.dataSource.getRepository('orders');",
        '  }',
        '',
        '  count(): Promise<number> {',
        '    return this.orders().count();',
        '  }',
        '',
        '  inTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {',
        '    return this.dataSource.transaction(work);',
        '  }',
        '}',
      ),
    });

    expectPasses(run, [file]);
  });

  const healthController = (className: string) =>
    ts(
      "import { Controller, Get } from '@nestjs/common';",
      "import { DataSource } from 'typeorm';",
      '',
      "@Controller('health')",
      `export class ${className} {`,
      '  constructor(private readonly dataSource: DataSource) {}',
      '',
      '  @Get()',
      '  check(): Promise<unknown> {',
      "    return this.dataSource.query('SELECT 1');",
      '  }',
      '}',
    );

  it('[UC-SR-47] the four named exemptions pass the lint', () => {
    const named = {
      'src/health/health.controller.ts': healthController('HealthController'),
      'src/database/database.module.ts': ts(
        "import { Module } from '@nestjs/common';",
        "import { TypeOrmModule } from '@nestjs/typeorm';",
        '',
        "@Module({ imports: [TypeOrmModule.forRoot({ type: 'postgres' })] })",
        'export class DatabaseModule {}',
      ),
      'src/database/data-source.ts': ts(
        "import { DataSource } from 'typeorm';",
        '',
        "export default new DataSource({ type: 'postgres' });",
      ),
      'test/support/seed.ts': ts(
        "import { DataSource } from 'typeorm';",
        '',
        'export async function seed(dataSource: DataSource): Promise<void> {',
        "  await dataSource.query('SELECT 1');",
        '}',
      ),
    };

    const run = lintProbe(named);

    expectPasses(run, Object.keys(named));
  });

  it('[UC-SR-47] near-miss files beside the exemptions still fail: exemptions are exact files, not folders', () => {
    const run = lintProbe({
      'src/database/other.ts': ts(
        "import { TypeOrmModule } from '@nestjs/typeorm';",
        "import { DataSource } from 'typeorm';",
        '',
        "export const connection = TypeOrmModule.forRoot({ type: 'postgres' });",
        "export const cli = new DataSource({ type: 'postgres' });",
      ),
      'src/health/other.controller.ts': healthController('OtherController'),
    });

    expectFlagged(run, 'src/database/other.ts', [1, 2]);
    expectFlagged(run, 'src/health/other.controller.ts', [2]);
  });

  it('[UC-SR-48] entities, migrations and options may still import the other typeorm names', () => {
    const files = {
      'src/orders/order.entity.ts': ts(
        "import { Column, Entity, Index } from 'typeorm';",
        '',
        "@Entity('orders')",
        "@Index(['siteId'])",
        'export class Order {',
        "  @Column('uuid')",
        '  siteId: string;',
        '}',
      ),
      'src/database/migrations/1790000000000-AddOrders.ts': ts(
        "import { MigrationInterface, QueryRunner } from 'typeorm';",
        '',
        'export class AddOrders1790000000000 implements MigrationInterface {',
        '  async up(queryRunner: QueryRunner): Promise<void> {',
        "    await queryRunner.query('SELECT 1');",
        '  }',
        '',
        '  async down(queryRunner: QueryRunner): Promise<void> {',
        "    await queryRunner.query('SELECT 1');",
        '  }',
        '}',
      ),
      'src/database/data-source-options.ts': ts(
        "import type { DataSourceOptions } from 'typeorm';",
        '',
        "export const options: DataSourceOptions = { type: 'postgres' };",
      ),
    };

    const run = lintProbe(files);

    expectPasses(run, Object.keys(files));
  });

  it('[UC-SR-49] the lint message tells the developer to go through a *.repository.ts file and cites invariant 1', () => {
    const file = 'src/orders/orders.service.ts';
    const run = lintProbe({ [file]: ordersService });

    const [problem] = restrictedImports(run, file);
    expect(
      problem,
      `no restricted-import problem on ${file}; ${summary(run)}`,
    ).toBeDefined();
    // What a developer reads: the rule's message plus the configured help text.
    const text = `${problem.message}\n${problem.help ?? ''}`;
    expect(text).toMatch(/repository\.ts/);
    expect(text).toMatch(/\binvariant 1\b|CLAUDE\.md/i);
  });

  it("[UC-SR-50] the project's own src/ and test/ pass, with the rule loaded from the real config", () => {
    realConfig();

    // The rule must be in the config oxlint auto-discovers from the repo root; otherwise a clean
    // run below would prove nothing.
    const printed = oxlint(repoRoot, ['--print-config']);
    const effective = parseJson<{ rules: Record<string, unknown> }>(
      printed,
      'the effective config',
    );
    const setting = Object.entries(effective.rules).find(
      ([name]) => name === rule || name.endsWith(`/${rule}`),
    )?.[1];
    const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
    expect(
      ['deny', 'error'],
      `${rule} must be switched on at error level in the config oxlint finds from the repo root`,
    ).toContain(severity);

    const run = lint(repoRoot);

    expect(
      run.diagnostics.filter(isRestrictedImport),
      `every real file that legitimately uses the TypeORM handles must be exempt; ${summary(run)}`,
    ).toEqual([]);
    expect(run.status, summary(run)).toBe(0);
  });
});
