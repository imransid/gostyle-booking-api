import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(import.meta.dirname, p);

export default defineConfig({
  test: {
    include: [
      'src/domain/**/*.spec.ts',
      'src/application/**/*.spec.ts',
      'src/infrastructure/**/*.spec.ts',
    ],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@domain':         r('src/domain'),
      '@application':    r('src/application'),
      '@infrastructure': r('src/infrastructure'),
      '@interface':      r('src/interface'),
    },
  },
});
