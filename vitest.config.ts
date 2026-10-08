import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Built into Vite 8; no plugin needed.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // The app will not start without a signing secret; CI has no env file to supply one.
    env: {
      JWT_SECRET:
        process.env.JWT_SECRET ?? 'test-only-jwt-secret-0123456789abcdef',
    },
  },
});
