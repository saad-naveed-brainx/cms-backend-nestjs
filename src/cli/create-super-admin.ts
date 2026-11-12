import { runCreateSuperAdmin } from './run-create-super-admin.js';

/**
 * Entrypoint of `npm run create-super-admin` (built to `dist/cli/create-super-admin.js`). It only
 * wires the real process to `runCreateSuperAdmin`: the arguments after the script name, the
 * environment, the console, and the exit code.
 */
process.exit(
  await runCreateSuperAdmin(process.argv.slice(2), process.env, {
    out: console.log,
    err: console.error,
  }),
);
