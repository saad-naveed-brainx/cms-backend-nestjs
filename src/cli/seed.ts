import { runSeed } from './run-seed.js';

/**
 * Entrypoint of `npm run seed` (built to `dist/cli/seed.js`). It only wires the real process to
 * `runSeed`: the arguments after the script name, the environment, the console, and the exit code.
 */
process.exit(
  await runSeed(process.argv.slice(2), process.env, {
    out: console.log,
    err: console.error,
  }),
);
