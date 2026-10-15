import { runDemo } from './run-demo.js';

/**
 * Entrypoint of `npm run demo` (built to `dist/cli/demo.js`): wires the real process to `runDemo`,
 * the arguments after the script name, the environment, the console, and the exit code.
 */
process.exit(
  await runDemo(process.argv.slice(2), process.env, {
    out: console.log,
    err: console.error,
  }),
);
